#!/usr/bin/env node
// Edit-claim precision/recall benchmark runner.
//
// Loads scripts/bench/editclaim-corpus.jsonl (version-controlled ground
// truth), runs the BUILT editClaimCheck from packages/core/dist against
// each case, and prints a precision/recall table plus per-case failures.
//
// Requires `npm run build:node` to have been run first (imports the
// compiled core package, not TypeScript source).
//
// Exit code: 0 when precision === 1.0 AND recall >= 0.95; 1 otherwise.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { editClaimCheck } from "../../packages/core/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(__dirname, "editclaim-corpus.jsonl");

const PRECISION_THRESHOLD = 1.0;
// current corpus recall: 1.0 — do not lower this floor without a controller decision
const RECALL_THRESHOLD = 0.95;

function loadCorpus(corpusPath) {
  const raw = readFileSync(corpusPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Failed to parse corpus line ${i + 1}: ${err.message}`);
      }
    });
}

function makeNode(text) {
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

const failFetch = async () => {
  throw new Error("network should not be called by editClaimCheck");
};

async function runCase(testCase) {
  const node = makeNode(testCase.text);
  const ctx = {
    node,
    priorNodes: [node],
    diff: (testCase.diffPaths ?? []).map((d) => ({
      path: d.path,
      status: d.status,
      ...(d.oldPath ? { oldPath: d.oldPath } : {}),
    })),
    parentTree: testCase.parentTree ?? null,
    nodeTree: testCase.nodeTree ?? null,
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

async function main() {
  const cases = loadCorpus(CORPUS_PATH);

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const failures = [];

  for (const testCase of cases) {
    const { flags } = await runCase(testCase);
    const actual = flags.length > 0 ? "flag" : "silent";
    const expected = testCase.expect;

    if (expected === "flag" && actual === "flag") tp++;
    else if (expected === "silent" && actual === "flag") {
      fp++;
      failures.push({ ...testCase, actual, flags });
    } else if (expected === "flag" && actual === "silent") {
      fn++;
      failures.push({ ...testCase, actual, flags });
    } else tn++;
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

  console.log("Edit-claim precision/recall benchmark");
  console.log("======================================");
  console.log(`Corpus:    ${cases.length} cases (${CORPUS_PATH})`);
  console.log(`TP=${tp}  FP=${fp}  FN=${fn}  TN=${tn}`);
  console.log(`Precision: ${precision.toFixed(4)} (threshold >= ${PRECISION_THRESHOLD})`);
  console.log(`Recall:    ${recall.toFixed(4)} (threshold >= ${RECALL_THRESHOLD})`);
  console.log("");

  if (failures.length > 0) {
    console.log(`Failures (${failures.length}):`);
    for (const f of failures) {
      console.log(`  [${f.id}] expected=${f.expect} actual=${f.actual}`);
      console.log(`    text: ${f.text}`);
      console.log(`    note: ${f.note}`);
      if (f.flags.length > 0) {
        for (const flag of f.flags) {
          console.log(`    flag: (${flag.confidence}) ${flag.evidence}`);
        }
      }
    }
    console.log("");
  }

  const passed = precision >= PRECISION_THRESHOLD && recall >= RECALL_THRESHOLD;
  console.log(
    passed
      ? "RESULT: PASS"
      : `RESULT: FAIL (achieved precision=${precision.toFixed(4)}, recall=${recall.toFixed(4)}; ` +
        `required precision === ${PRECISION_THRESHOLD}, recall >= ${RECALL_THRESHOLD})`,
  );

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
