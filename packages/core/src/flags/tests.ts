import type { ChronoNode, Flag } from "../types.js";
import type { CheckContext, FlagCheck } from "../interfaces.js";
import { extractSearchableText, getNodeText } from "./claims.js";

const CLAIM_PATTERNS = [
  /\b(all\s+)?tests?\s+(now\s+)?(pass|passing|green)\b/i,
  /\bbuild\s+(succeeds|passes|is\s+green)\b/i,
];

const RUNNER_SIGNATURE =
  /\b(vitest|jest|mocha|pytest|go\s+test|cargo\s+test|npm\s+test|pnpm\s+test|tsc)\b/i;

const FAILURE_PATTERN = /(fail|failed|failing|error|✗|✖|FAILED|[1-9]\d*\s+failed)/i;

function textClaimsTestsPass(text: string): boolean {
  return CLAIM_PATTERNS.some((re) => re.test(text));
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
    const failing = FAILURE_PATTERN.test(resultText);
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
