import type { ChronoNode, Flag } from "../types.js";
import type { CheckContext, FlagCheck } from "../interfaces.js";
import { getNodeText } from "./claims.js";

const BACKTICK_TOKEN = /`([^`\n]+)`/g;

const EXISTENCE_PHRASES = [
  "in",
  "at",
  "inside",
  "see",
  "check",
  "open",
  "file",
  "defined in",
  "located",
];

/** A repo-relative-looking file path: contains `/` AND has an extension,
 * isn't a URL, isn't a glob, isn't under node_modules, and isn't an
 * absolute path (outside-root absolute paths are rejected outright since we
 * only ever compare against repo-relative listFiles() results). */
function looksLikeRepoRelativePath(token: string): boolean {
  const t = token.trim();
  if (t.length === 0) return false;
  if (/\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // scheme://
  if (/^(https?|ftp|git|ssh):/i.test(t)) return false;
  if (t.startsWith("/")) return false; // absolute path
  if (t.startsWith("~")) return false;
  if (t.includes("*") || t.includes("?") || t.includes("[")) return false; // globs
  if (!t.includes("/")) return false;
  if (!/\.[a-zA-Z0-9]{1,10}$/.test(t)) return false; // must end in an extension
  if (t.split("/").some((seg) => seg === "node_modules")) return false;
  return true;
}

function hasExistencePhraseBefore(text: string, tokenStart: number, windowChars = 40): boolean {
  const start = Math.max(0, tokenStart - windowChars);
  const before = text.slice(start, tokenStart).toLowerCase();
  return EXISTENCE_PHRASES.some((phrase) => {
    const re = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "i");
    return re.test(before);
  });
}

export const fileRefsCheck: FlagCheck = {
  kind: "file_ref_missing",

  appliesTo(node: ChronoNode): boolean {
    return node.kind === "assistant" && getNodeText(node) !== null;
  },

  async run(ctx: CheckContext): Promise<Flag[]> {
    if (ctx.nodeTree === null || ctx.snapshotter === null) return [];
    const text = getNodeText(ctx.node);
    if (text === null) return [];

    const tokens: { path: string; index: number }[] = [];
    BACKTICK_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BACKTICK_TOKEN.exec(text)) !== null) {
      const token = m[1].trim();
      if (!looksLikeRepoRelativePath(token)) continue;
      if (!hasExistencePhraseBefore(text, m.index)) continue;
      tokens.push({ path: token, index: m.index });
    }
    if (tokens.length === 0) return [];

    const files = await ctx.snapshotter.listFiles(ctx.nodeTree);
    const fileSet = new Set(files);
    const deletedPaths = new Set(
      ctx.diff.filter((d) => d.status === "D").map((d) => d.path),
    );

    const flags: Flag[] = [];
    const seen = new Set<string>();
    for (const { path: p } of tokens) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (fileSet.has(p)) continue;
      if (deletedPaths.has(p)) continue;
      flags.push({
        kind: "file_ref_missing",
        tier: "verified",
        confidence: "medium",
        evidence: `claimed reference to \`${p}\`; that path is not present in the snapshot tree`,
        source: "deterministic",
      });
    }
    return flags;
  },
};
