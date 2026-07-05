import type { ChronoNode, Flag } from "../types.js";
import type { CheckContext, FlagCheck } from "../interfaces.js";
import { getNodeText } from "./claims.js";

// `name()` — a backticked identifier immediately followed by parens.
const CALL_PATTERN = /`([A-Za-z_$][A-Za-z0-9_$.]*)\(\)`/g;
// function/method/class `name` — a backticked identifier preceded by one of
// these role words (with optional whitespace).
const LABELED_PATTERN = /\b(?:function|method|class)\s+`([A-Za-z_$][A-Za-z0-9_$.]*)`/gi;

const FILE_TOKEN = /`([^`\n]+)`/g;

function looksLikeFileToken(token: string): boolean {
  const t = token.trim();
  if (t.length === 0) return false;
  if (/\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (t.startsWith("/") || t.startsWith("~")) return false;
  if (t.includes("*") || t.includes("?") || t.includes("[")) return false;
  if (!t.includes("/")) return false;
  if (!/\.[a-zA-Z0-9]{1,10}$/.test(t)) return false;
  return true;
}

/** Split text into naive sentences on `.`/`!`/`?`, but never split in the
 * middle of a backticked span (file paths like `src/utils.ts` contain a
 * literal `.` that must not terminate the sentence early). */
function splitSentences(text: string): { text: string; start: number }[] {
  const sentences: { text: string; start: number }[] = [];
  let sentenceStart = 0;
  let inBacktick = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "`") {
      inBacktick = !inBacktick;
      continue;
    }
    if (!inBacktick && (ch === "." || ch === "!" || ch === "?")) {
      // consume any run of trailing punctuation (e.g. "?!" or "...")
      let end = i + 1;
      while (end < text.length && ".!?".includes(text[end])) end++;
      const chunk = text.slice(sentenceStart, end);
      if (chunk.trim().length > 0) sentences.push({ text: chunk, start: sentenceStart });
      sentenceStart = end;
      i = end - 1;
    }
  }
  if (sentenceStart < text.length) {
    const chunk = text.slice(sentenceStart);
    if (chunk.trim().length > 0) sentences.push({ text: chunk, start: sentenceStart });
  }
  if (sentences.length === 0) sentences.push({ text, start: 0 });
  return sentences;
}

interface SymbolMention {
  name: string;
}

function findSymbolMentions(sentence: string): SymbolMention[] {
  const mentions: SymbolMention[] = [];
  CALL_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_PATTERN.exec(sentence)) !== null) mentions.push({ name: m[1] });
  LABELED_PATTERN.lastIndex = 0;
  while ((m = LABELED_PATTERN.exec(sentence)) !== null) mentions.push({ name: m[1] });
  return mentions;
}

function findFileTokens(sentence: string): string[] {
  const tokens: string[] = [];
  FILE_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_TOKEN.exec(sentence)) !== null) {
    const token = m[1].trim();
    if (looksLikeFileToken(token)) tokens.push(token);
  }
  return tokens;
}

export const symbolsCheck: FlagCheck = {
  kind: "symbol_not_found",

  appliesTo(node: ChronoNode): boolean {
    return node.kind === "assistant" && getNodeText(node) !== null;
  },

  async run(ctx: CheckContext): Promise<Flag[]> {
    if (ctx.nodeTree === null || ctx.snapshotter === null) return [];
    const text = getNodeText(ctx.node);
    if (text === null) return [];

    const sentences = splitSentences(text);
    const flags: Flag[] = [];
    const fileContentCache = new Map<string, string | null>();
    const seen = new Set<string>();

    for (const sentence of sentences) {
      const mentions = findSymbolMentions(sentence.text);
      if (mentions.length === 0) continue;
      const fileTokens = findFileTokens(sentence.text);
      if (fileTokens.length === 0) continue;

      for (const fileToken of fileTokens) {
        let content = fileContentCache.get(fileToken);
        if (content === undefined) {
          content = await ctx.snapshotter.readFile(ctx.nodeTree, fileToken);
          fileContentCache.set(fileToken, content);
        }
        if (content === null) continue; // token doesn't resolve to an existing file

        for (const mention of mentions) {
          const key = `${fileToken}::${mention.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (content.includes(mention.name)) continue;
          flags.push({
            kind: "symbol_not_found",
            tier: "verified",
            confidence: "high",
            evidence: `claimed symbol \`${mention.name}\` in \`${fileToken}\`; that file's content has no occurrence of \`${mention.name}\``,
            source: "deterministic",
          });
        }
      }
    }

    return flags;
  },
};
