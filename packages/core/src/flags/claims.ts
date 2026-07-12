import type { ChronoNode } from "../types.js";

/**
 * Extracts the plain text of a node's content, handling both shapes we may
 * see in practice: a raw string, or a `{ type: "text", text: string }` block
 * (the shape Claude/OpenCode content blocks use). Returns null when there is
 * no extractable string text (e.g. tool_use/tool_result payload objects).
 */
export function getNodeText(node: ChronoNode): string | null {
  return contentToText(node.content);
}

export function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "type" in content) {
    const block = content as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

/** True only for assistant-kind nodes whose content resolves to a string. */
export function isTextAssistantNode(node: ChronoNode): boolean {
  return node.kind === "assistant" && getNodeText(node) !== null;
}

/**
 * Best-effort text extraction for nodes whose content shape isn't committed
 * yet (tool_use/tool_result payloads vary by adapter and aren't finalized).
 * Used only for substring/regex signature matching (e.g. "did a test runner
 * appear in this tool call"), never for claim precision logic. Falls back to
 * JSON.stringify so fields like `input.command` or `content` are still
 * searchable regardless of exact key names.
 */
export function extractSearchableText(content: unknown): string {
  const text = contentToText(content);
  if (text !== null) return text;
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/**
 * Returns the first backtick-quoted token in a string, or null if there is
 * none. Evidence strings produced by every T1 check are deterministic and
 * always name the claimed subject (path/package/symbol/file) as the first
 * backticked token — this is used to derive a stable per-claim identity for
 * comparing flags across re-runs (see `autoResolveFlags`).
 */
export function firstBacktickedToken(text: string): string | null {
  const m = /`([^`\n]+)`/.exec(text);
  return m ? m[1] : null;
}

/**
 * Returns every backtick-quoted token in a string, in order of appearance.
 * Used to derive claim identity from evidence strings that name more than
 * one subject (e.g. symbol_not_found's "claimed symbol `sym` in `file`; ..."
 * names both the symbol AND the file it was claimed to be in). Using only
 * the first token there would collide two flags about the same symbol name
 * in two different files — the full ordered list disambiguates them.
 */
export function allBacktickedTokens(text: string): string[] {
  const tokens: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) tokens.push(m[1]);
  return tokens;
}

export type ClaimKind = "EDIT" | "CREATE" | "DELETE" | "RENAME";

export interface EditClaim {
  kind: ClaimKind;
  /** the raw backticked path token, as written in the text */
  path: string;
  /** index into text where the verb starts, for diagnostics */
  index: number;
}

const EDIT_VERBS = [
  "updated",
  "edited",
  "modified",
  "changed",
  "fixed",
  "refactored",
  "rewrote",
];
const CREATE_VERBS = ["created", "added", "wrote"];
const DELETE_VERBS = ["deleted", "removed"];
// RENAME-class verbs claim the file MOVED, so a rename diff entry satisfies
// them via either side (`oldPath` for the source, `path` for the target).
// Split out of EDIT (round 2) so a plain EDIT claim can no longer be
// silently satisfied by an unrelated rename whose `oldPath` happens to
// match the claimed file (see resolveDiffMatches in editClaim.ts).
const RENAME_VERBS = ["renamed", "moved"];
const ALL_VERBS = [...EDIT_VERBS, ...CREATE_VERBS, ...DELETE_VERBS, ...RENAME_VERBS];

function verbToKind(verb: string): ClaimKind {
  const v = verb.toLowerCase();
  if (CREATE_VERBS.includes(v)) return "CREATE";
  if (DELETE_VERBS.includes(v)) return "DELETE";
  if (RENAME_VERBS.includes(v)) return "RENAME";
  return "EDIT";
}

const VERB_PATTERN = ALL_VERBS.join("|");
// Backticked token, captured without backticks.
const BACKTICK_TOKEN = /`([^`\n]+)`/g;

/**
 * A relative-file-path-looking token: contains a `.` or `/`, no whitespace,
 * not a URL, not a glob, not an absolute path outside a project (we allow
 * leading `/` here since callers decide root-relativity; editClaim itself
 * only cares about relative-looking tokens so we reject leading `/` and
 * `~`), and not a shell command (no spaces already excluded by \S).
 */
export function looksLikeRelativeFilePath(token: string): boolean {
  const t = token.trim();
  if (t.length === 0) return false;
  if (/\s/.test(t)) return false; // commands with spaces
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URL scheme://
  if (/^(https?|ftp|git|ssh):/i.test(t)) return false;
  if (t.startsWith("/")) return false; // absolute path
  if (t.startsWith("~")) return false;
  // Import-alias specifiers are module ids, not repo paths — reject them as
  // claim subjects. Keep in sync with packages.ts `isAliasedImport`, which
  // skips the same prefixes for imports: `@/…` (bundler/tsconfig alias),
  // `~/…` (covered by the `~` reject above), `#…` (Node subpath imports).
  //
  // KNOWN PRECISION-FIRST LIMITATION (round 2, deliberate): alias resolution
  // is out of scope — silence over guessing. Mapping `@/lib/x.ts` or
  // `#internal/db.js` to a real repo path requires tsconfig/package.json
  // context the checker does not have, and a wrong guess would false-flag
  // TRUTHFUL alias-spelled claims (corpus ec-e4). The accepted cost is that
  // a FALSE alias-spelled claim also stays silent (corpus ec-o6): these
  // tokens are never claim subjects, in either direction.
  if (t.startsWith("@/")) return false;
  if (t.startsWith("#")) return false;
  if (t.includes("*") || t.includes("?") || t.includes("[")) return false; // globs
  if (!(t.includes(".") || t.includes("/"))) return false;
  // reject things that are clearly not paths, e.g. "e.g." or "i.e." (no
  // slash and only a single short alpha segment before a trailing dot with
  // nothing after) — heuristic: must have a final segment with an
  // extension-like suffix or contain a slash.
  const hasSlash = t.includes("/");
  const hasExtLike = /\.[a-zA-Z0-9]{1,10}$/.test(t);
  if (!hasSlash && !hasExtLike) return false;
  return true;
}

// --- Hedge / negation suppression ------------------------------------------
// Mirrors the sentence-scoped hedge approach in tests.ts (`isHedgedMatch`),
// but scoping is CLAUSE-aware (round 2): a hedge or negation only reaches a
// claim verb inside its own clause — except clause-initial conditionals
// ("Once tests pass, I will have updated `x`"), which govern the rest of
// their sentence. Suppression favors precision per the design principles: a
// suppressed claim can never become a false flag — but round 2 tightened
// the windows because over-suppression was letting materially FALSE claims
// ("This should fix the flaky test, and I updated `x.py`") pass silently.
const SENTENCE_BOUNDARY = /[.!?;\n]/;

// Clause boundaries: commas/colons end a clause, and so does the dash
// family — em dash (—), en dash (–), and a hyphen used as a dash, i.e.
// flanked by spaces (" - ", " -- "). "I didn't just tweak it — I rewrote
// `x.py`" asserts the rewrite in its own clause; the negation before the
// dash must not leak across it. Spaced hyphens are multi-char, so they are
// handled by `clauseWindowBefore`'s truncation pass, not this char class
// (an unspaced hyphen, as in `re-ran` or a `-v` flag, is NOT a boundary).
const CLAUSE_BOUNDARY = /[.!?;:\n,–—]/;
const SPACED_DASH = /[ \t]-+[ \t]/g;

// Negation is clause-scoped: "I haven't updated `x`" is a truthful
// non-claim, but "I didn't touch the tests, but I updated `x`" (comma) and
// "I didn't just tweak it — I rewrote `x.py`" (dash) still assert the edit
// in its own clause.
const NEGATION_MARKER = /\b(not|never|no longer)\b|n't\b/i;

// Future/modal markers state intention or possibility, not completion — but
// they suppress ONLY when directly governing the claim verb: marker +
// optional adverbs + optional "have" + verb ("will have updated", "I'll
// probably have refactored"). An intervening other verb breaks governance:
// "I will note that I updated `x.py`" asserts an already-completed edit and
// must stay a claim.
const FUTURE_MARKER =
  /\b(?:will|would|should|could|may|might|shall|going to|plan(?:ning)? to|about to|intend(?:s|ed)? to)\b|'ll\b/gi;
const GOVERNANCE_GAP =
  /^(?:\s+(?:\w+ly|also|just|soon|now|then|first|again))*(?:\s+have)?(?:\s+(?:\w+ly|also|just|soon|now|then|first|again))*\s*$/i;

// Conditionals suppress from two positions: inside the claim verb's own
// clause, or clause-initial ("Once tests pass, I will have updated `x`" —
// ec-e1) where they govern the rest of the sentence. "once" is excluded
// when it heads the adverbial idiom "once again"/"once more", which marks a
// completed repeat action, not a condition ("Once again I updated `x.py`").
const CONDITIONAL_MARKER = /\b(once|if|when|until|unless)\b/gi;
const ONCE_IDIOM = /^\s+(?:again|more)\b/i;
// Clause-initial = at the start of the sentence window, or right after a
// clause boundary (comma/colon/dash) within it.
const CLAUSE_INITIAL_PREFIX = /(?:^\s*|[,:–—]\s*|[ \t]-+[ \t]+)$/;

/** Index of the first character after the nearest `boundary` character
 * before `index` (or 0 if none) — the start of the sentence/clause that
 * contains `index`. Same scoping as tests.ts's `sentenceStartBefore`. */
function windowStartBefore(text: string, index: number, boundary: RegExp): number {
  for (let i = index - 1; i >= 0; i--) {
    if (boundary.test(text[i])) return i + 1;
  }
  return 0;
}

/** The clause containing `index` (text from the nearest clause boundary up
 * to `index`), with a spaced-hyphen dash (" - ", " -- ") also treated as a
 * boundary — those are multi-char, so they can't live in CLAUSE_BOUNDARY's
 * single-char class and are trimmed here instead. */
function clauseWindowBefore(text: string, index: number): string {
  let window = text.slice(windowStartBefore(text, index, CLAUSE_BOUNDARY), index);
  let lastDashEnd = -1;
  for (const m of window.matchAll(SPACED_DASH)) {
    lastDashEnd = (m.index ?? 0) + m[0].length;
  }
  if (lastDashEnd >= 0) window = window.slice(lastDashEnd);
  return window;
}

/**
 * True when the claim verb at `verbIndex` must not count as a completed-edit
 * claim because it is:
 *  - negated within its own clause ("haven't updated"), or
 *  - directly governed by a future/modal marker ("will have updated",
 *    "I'll probably have refactored"), or
 *  - governed by a conditional in its clause or a clause-initial conditional
 *    earlier in the sentence ("Once tests pass, …").
 */
function isSuppressedClaimVerb(text: string, verbIndex: number): boolean {
  const sentenceWindow = text.slice(
    windowStartBefore(text, verbIndex, SENTENCE_BOUNDARY),
    verbIndex,
  );
  const clauseWindow = clauseWindowBefore(text, verbIndex);

  if (NEGATION_MARKER.test(clauseWindow)) return true;

  for (const m of sentenceWindow.matchAll(FUTURE_MARKER)) {
    const gap = sentenceWindow.slice((m.index ?? 0) + m[0].length);
    if (GOVERNANCE_GAP.test(gap)) return true;
  }

  const clauseStartInSentence = sentenceWindow.length - clauseWindow.length;
  for (const m of sentenceWindow.matchAll(CONDITIONAL_MARKER)) {
    const at = m.index ?? 0;
    if (m[1].toLowerCase() === "once" && ONCE_IDIOM.test(sentenceWindow.slice(at + m[0].length))) {
      continue;
    }
    const inVerbClause = at >= clauseStartInSentence;
    if (inVerbClause || CLAUSE_INITIAL_PREFIX.test(sentenceWindow.slice(0, at))) return true;
  }

  return false;
}

/**
 * Extract edit-claims from assistant text: a claim verb within 60 chars
 * before a backticked path-looking token. Verbs that are hedged (future/
 * conditional) or negated in their own sentence/clause are not claims.
 */
export function extractEditClaims(text: string): EditClaim[] {
  const claims: EditClaim[] = [];
  const verbRegex = new RegExp(`\\b(${VERB_PATTERN})\\b`, "gi");
  let verbMatch: RegExpExecArray | null;
  const verbPositions: { verb: string; index: number }[] = [];
  while ((verbMatch = verbRegex.exec(text)) !== null) {
    verbPositions.push({ verb: verbMatch[1], index: verbMatch.index });
  }
  if (verbPositions.length === 0) return claims;

  BACKTICK_TOKEN.lastIndex = 0;
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = BACKTICK_TOKEN.exec(text)) !== null) {
    const token = tokenMatch[1];
    const tokenStart = tokenMatch.index;
    if (!looksLikeRelativeFilePath(token)) continue;

    // find the closest preceding verb within 60 chars before the backtick
    // that opens this token (tokenStart is the index of the opening `).
    let best: { verb: string; index: number } | null = null;
    for (const vp of verbPositions) {
      if (vp.index > tokenStart) continue;
      const gap = tokenStart - (vp.index + vp.verb.length);
      if (gap < 0) continue; // verb inside/after token start overlap, skip
      if (gap <= 60) {
        if (!best || vp.index > best.index) best = vp;
      }
    }
    if (!best) continue;
    if (isSuppressedClaimVerb(text, best.index)) continue;
    claims.push({ kind: verbToKind(best.verb), path: token.trim(), index: best.index });
  }
  return claims;
}
