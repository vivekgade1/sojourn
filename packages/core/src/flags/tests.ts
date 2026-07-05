import type { ChronoNode, Flag } from "../types.js";
import type { CheckContext, FlagCheck } from "../interfaces.js";
import { extractSearchableText, getNodeText } from "./claims.js";

const CLAIM_PATTERNS = [
  /\b(all\s+)?tests?\s+(now\s+)?(pass|passing|green)\b/i,
  /\bbuild\s+(succeeds|passes|is\s+green)\b/i,
];

const RUNNER_SIGNATURE =
  /\b(vitest|jest|mocha|pytest|go\s+test|cargo\s+test|npm\s+test|pnpm\s+test|tsc)\b/i;

// Only STRONG failure signals count. A bare substring "fail"/"error" is too
// weak — it over-matches passing runs whose output happens to mention a test
// name like "handles error case" or a caught-and-logged warning. Precision
// over recall: anything weaker than these patterns is treated as a good/
// ambiguous run and stays silent rather than risking a false HIGH flag.
// Note: "0 failed" must NOT match (a literal zero-count is a passing run).
const FAILURE_PATTERNS = [
  /\b[1-9]\d*\s+fail(?:ed|ing|ures?)?\b/i,
  /\bFAILED\b/,
  /✗|✖/,
  /\bexit code [1-9]\d*\b/i,
];

function isFailingRun(text: string): boolean {
  return FAILURE_PATTERNS.some((re) => re.test(text));
}

// Suppress a claim match when it's quoted/future/conditional phrasing rather
// than a direct present-tense assertion, e.g. "once tests pass we can merge"
// or "You asked me to make sure all tests pass — here's my plan". We look
// for a genuine modal/future/conditional/quote marker *within the same
// sentence* as the match (not a raw character window, which can cross
// sentence boundaries and pick up unrelated words like "after"/"before"/
// "want" that appear earlier in a prior clause but don't hedge this claim).
// Only true hedge words count — weak/ambiguous bare words like "after",
// "before", "want", "need", "asked" were dropped because they show up
// constantly in genuine, unhedged claims (e.g. "I ran the tests before lunch
// and all tests pass" or "I want to note that all tests pass").
const HEDGE_MARKER =
  /\b(will|would|should|could|may|might|once|if|until|unless|when|going to|so that|make sure|ensure|you asked|plan to|want to make sure)\b/i;

function isHedgedMatch(text: string, matchIndex: number): boolean {
  const sentenceStart = sentenceStartBefore(text, matchIndex);
  const window = text.slice(sentenceStart, matchIndex);
  if (HEDGE_MARKER.test(window)) return true;

  // Markdown blockquote: the match's line starts with ">" (ignoring leading
  // whitespace).
  const lineStart = text.lastIndexOf("\n", matchIndex) + 1;
  const line = text.slice(lineStart, matchIndex);
  if (/^\s*>/.test(line)) return true;

  // Inside inline backticks or a fenced code block: count backtick-delimited
  // spans and triple-backtick fences before the match; an odd count means
  // we're inside one.
  const before = text.slice(0, matchIndex);
  const fenceCount = (before.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) return true;
  const backtickCount = (before.match(/`/g) ?? []).length;
  if (backtickCount % 2 === 1) return true;

  return false;
}

// Sentence boundary characters for scoping hedge detection to "same
// sentence as the match" (per finding 3: a raw character window crosses
// sentence boundaries and false-suppresses genuine claims in a later
// sentence, e.g. "I ran the test suite before lunch. All tests pass.").
const SENTENCE_BOUNDARY = /[.!?;\n]/;

/**
 * Returns the index just after the nearest sentence-boundary character
 * before `matchIndex` (or 0 if none), i.e. the start of the sentence that
 * contains `matchIndex`.
 */
function sentenceStartBefore(text: string, matchIndex: number): number {
  for (let i = matchIndex - 1; i >= 0; i--) {
    if (SENTENCE_BOUNDARY.test(text[i])) return i + 1;
  }
  return 0;
}

function textClaimsTestsPass(text: string): boolean {
  for (const re of CLAIM_PATTERNS) {
    const withIndex = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = withIndex.exec(text)) !== null) {
      if (!isHedgedMatch(text, m.index)) return true;
      if (withIndex.lastIndex === m.index) withIndex.lastIndex++; // avoid infinite loop on zero-width
    }
  }
  return false;
}

/**
 * Walk `priorNodes` backward from (but not including) `node` until we hit
 * the previous `prompt` node, looking for a tool_use whose invocation text
 * matches a known test/build runner signature and its corresponding
 * tool_result (the node immediately following it in priorNodes, matching
 * how adapters emit tool_result nodes right after their tool_use).
 */
function findLastRunSinceLastPrompt(
  node: ChronoNode,
  priorNodes: ChronoNode[],
): { found: boolean; failing: boolean } {
  const idx = priorNodes.findIndex((n) => n.id === node.id);
  const upTo = idx === -1 ? priorNodes.length : idx;

  // Walk backward; stop once we pass the previous prompt node.
  for (let i = upTo - 1; i >= 0; i--) {
    const n = priorNodes[i];
    if (n.kind === "prompt") break;
    if (n.kind !== "tool_use") continue;

    const useText = extractSearchableText(n.content);
    if (!RUNNER_SIGNATURE.test(useText)) continue;

    // The corresponding tool_result: the very next node chronologically
    // after this tool_use in priorNodes (adapters parent tool_result to its
    // tool_use, and priorNodes is chronological).
    const result = priorNodes[i + 1];
    if (!result || result.kind !== "tool_result") continue;

    const resultText = extractSearchableText(result.content);
    const failing = isFailingRun(resultText);
    return { found: true, failing };
  }

  return { found: false, failing: false };
}

export const testsCheck: FlagCheck = {
  kind: "test_claim_unverified",

  appliesTo(node: ChronoNode): boolean {
    return node.kind === "assistant" && getNodeText(node) !== null;
  },

  async run(ctx: CheckContext): Promise<Flag[]> {
    const text = getNodeText(ctx.node);
    if (text === null) return [];
    if (!textClaimsTestsPass(text)) return [];

    const { found, failing } = findLastRunSinceLastPrompt(ctx.node, ctx.priorNodes);

    if (found && !failing) return []; // verified good run: no flag

    if (found && failing) {
      return [
        {
          kind: "test_claim_unverified",
          tier: "verified",
          confidence: "high",
          evidence: "claimed tests pass; observed failing run",
          source: "deterministic",
        },
      ];
    }

    return [
      {
        kind: "test_claim_unverified",
        tier: "verified",
        confidence: "medium",
        evidence: "claimed tests pass; no test run observed since last prompt",
        source: "deterministic",
      },
    ];
  },
};
