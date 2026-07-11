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

export type ClaimKind = "EDIT" | "CREATE" | "DELETE";

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
// "renamed" is a claim verb per the brief's verb list but doesn't map cleanly
// to EDIT/CREATE/DELETE; treat it as an EDIT-style claim (the old path should
// still show up as changed in some way in the diff).
const ALL_VERBS = [...EDIT_VERBS, ...CREATE_VERBS, ...DELETE_VERBS, "renamed"];

function verbToKind(verb: string): ClaimKind {
  const v = verb.toLowerCase();
  if (CREATE_VERBS.includes(v)) return "CREATE";
  if (DELETE_VERBS.includes(v)) return "DELETE";
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
// Mirrors the sentence-scoped hedge approach in tests.ts (`isHedgedMatch`):
// a claim verb preceded, within the same sentence, by a genuine future/
// conditional marker ("Once tests pass, I will have updated `x`") states an
// intention, not a completed edit, and must not be read as a claim. Only
// true hedge markers count — common narrative words ("after", "before",
// "then") are deliberately excluded because they appear constantly in
// genuine completed-work claims. `'ll` covers contractions ("I'll have
// updated"); "will|would|…" cover future-perfect "<modal> have <verb>".
const SENTENCE_BOUNDARY = /[.!?;\n]/;
const HEDGE_MARKER =
  /\b(will|would|should|could|may|might|shall|once|unless|until|going to|plan(?:ning)? to|about to|intend(?:s|ed)? to)\b|'ll\b/i;

// Negation is scoped tighter — to the clause (commas also end the window):
// "I haven't updated `x`" is a truthful non-claim, but "I didn't touch the
// tests, but I updated `x`" still asserts the edit in its own clause.
const CLAUSE_BOUNDARY = /[.!?;:\n,]/;
const NEGATION_MARKER = /\b(not|never|no longer)\b|n't\b/i;

/** Index of the first character after the nearest `boundary` character
 * before `index` (or 0 if none) — the start of the sentence/clause that
 * contains `index`. Same scoping as tests.ts's `sentenceStartBefore`. */
function windowStartBefore(text: string, index: number, boundary: RegExp): number {
  for (let i = index - 1; i >= 0; i--) {
    if (boundary.test(text[i])) return i + 1;
  }
  return 0;
}

/**
 * True when the claim verb at `verbIndex` is hedged (future/conditional,
 * incl. future-perfect "will have updated") or negated ("haven't updated",
 * "didn't change") and therefore must not count as a completed-edit claim.
 * Suppression favors precision per the design principles: a suppressed
 * claim can never become a false flag.
 */
function isSuppressedClaimVerb(text: string, verbIndex: number): boolean {
  const sentenceWindow = text.slice(
    windowStartBefore(text, verbIndex, SENTENCE_BOUNDARY),
    verbIndex,
  );
  if (HEDGE_MARKER.test(sentenceWindow)) return true;
  const clauseWindow = text.slice(windowStartBefore(text, verbIndex, CLAUSE_BOUNDARY), verbIndex);
  return NEGATION_MARKER.test(clauseWindow);
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
