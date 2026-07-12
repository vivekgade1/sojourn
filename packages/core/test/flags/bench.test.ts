import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { editClaimCheck } from "../../src/flags/editClaim.js";
import type { ChronoNode, FileChange } from "../../src/types.js";
import type { CheckContext, FetchJson } from "../../src/interfaces.js";

// Corpus lives at scripts/bench/editclaim-corpus.jsonl (version-controlled
// ground truth, shared with scripts/bench/run.mjs which runs the same
// evaluation against the BUILT package). This test runs the identical
// evaluation IN-PROCESS against SOURCE, so `npm test` catches precision/
// recall regressions without requiring a build step first.
const CORPUS_PATH = fileURLToPath(
  new URL("../../../../scripts/bench/editclaim-corpus.jsonl", import.meta.url),
);

const PRECISION_THRESHOLD = 1.0;
// current corpus recall: 1.0 — do not lower this floor without a controller decision
const RECALL_THRESHOLD = 0.95;

interface BenchCase {
  id: string;
  text: string;
  diffPaths: Array<{ path: string; status: "A" | "M" | "D" | "R"; oldPath?: string }>;
  parentTree: string | null;
  nodeTree: string | null;
  expect: "flag" | "silent";
  note: string;
}

function loadCorpus(): BenchCase[] {
  const raw = readFileSync(CORPUS_PATH, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BenchCase);
}

function makeNode(text: string): ChronoNode {
  return {
    id: "claude:bench-node",
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "bench-session",
    projectId: "bench-project",
    timestamp: new Date().toISOString(),
    snapshotRef: "bench-tree",
    label: null,
    summary: "",
    content: text,
    meta: { nativeUuid: "bench-node" },
  };
}

const failFetch: FetchJson = async () => {
  throw new Error("network should not be called by editClaimCheck");
};

async function runCase(testCase: BenchCase): Promise<{ flags: Awaited<ReturnType<typeof editClaimCheck.run>> }> {
  const node = makeNode(testCase.text);
  const diff: FileChange[] = testCase.diffPaths.map((d) => ({
    path: d.path,
    status: d.status,
    ...(d.oldPath ? { oldPath: d.oldPath } : {}),
  }));
  const ctx: CheckContext = {
    node,
    priorNodes: [node],
    diff,
    parentTree: testCase.parentTree,
    nodeTree: testCase.nodeTree,
    projectRoot: "/tmp/bench-project",
    snapshotter: null,
    fetchJson: failFetch,
  };

  if (!editClaimCheck.appliesTo(node)) {
    return { flags: [] };
  }
  const flags = await editClaimCheck.run(ctx);
  return { flags };
}

describe("edit-claim precision/recall benchmark (scripts/bench/editclaim-corpus.jsonl)", () => {
  it("has at least 40 hand-labeled cases", () => {
    const cases = loadCorpus();
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it("meets precision === 1.0 and recall >= 0.95 over the corpus", async () => {
    const cases = loadCorpus();

    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const falsePositiveIds: string[] = [];
    const falseNegativeIds: string[] = [];

    for (const testCase of cases) {
      const { flags } = await runCase(testCase);
      const actual: "flag" | "silent" = flags.length > 0 ? "flag" : "silent";

      if (testCase.expect === "flag" && actual === "flag") tp++;
      else if (testCase.expect === "silent" && actual === "flag") {
        fp++;
        falsePositiveIds.push(testCase.id);
      } else if (testCase.expect === "flag" && actual === "silent") {
        fn++;
        falseNegativeIds.push(testCase.id);
      } else tn++;
    }

    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

    const summary =
      `edit-claim bench: TP=${tp} FP=${fp} FN=${fn} TN=${tn} ` +
      `precision=${precision.toFixed(4)} recall=${recall.toFixed(4)}\n` +
      `false positives (expected silent, got flag): ${falsePositiveIds.join(", ") || "none"}\n` +
      `false negatives (expected flag, got silent): ${falseNegativeIds.join(", ") || "none"}`;

    expect(precision, `achieved precision=${precision.toFixed(4)}\n${summary}`).toBe(PRECISION_THRESHOLD);
    expect(recall, `achieved recall=${recall.toFixed(4)}\n${summary}`).toBeGreaterThanOrEqual(
      RECALL_THRESHOLD,
    );
  });
});
