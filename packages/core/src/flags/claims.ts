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

/**
 * Extract edit-claims from assistant text: a claim verb within 60 chars
 * before a backticked path-looking token.
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
    claims.push({ kind: verbToKind(best.verb), path: token.trim(), index: best.index });
  }
  return claims;
}
