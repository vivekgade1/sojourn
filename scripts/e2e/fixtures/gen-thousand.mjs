#!/usr/bin/env node
/**
 * Deterministic generator for scripts/e2e/fixtures/thousand-steps.jsonl — a
 * large (1000+ line) synthetic Claude session transcript used by the
 * conformance suite to smoke-test parseSessionJsonl at scale, including many
 * parallel-tool-call turns.
 *
 * Seeded PRNG (mulberry32): re-running this script reproduces the committed
 * fixture BYTE-FOR-BYTE. This script is run ONCE at authoring time; its
 * output (thousand-steps.jsonl) is committed and consumed directly by the
 * conformance suite — it is not regenerated at test time.
 *
 * Run:  node scripts/e2e/fixtures/gen-thousand.mjs
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SEED = 424242;
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
/** Uniform integer in [0, max). */
const randInt = (max) => Math.floor(rng() * max);

const SESSION_ID = "thousand-steps-session";
const CWD = "/repo/thousand-project";
export const TURN_COUNT = 260;

const TOOLS = ["Read", "Write", "Edit", "Bash", "Grep"];
const FILE_POOL = Array.from({ length: 40 }, (_, i) => `src/module_${i}.ts`);
const ASK_POOL = [
  "Check the module for edge cases.",
  "Update the handler to log errors.",
  "Run the tests for this module.",
  "Refactor the loop to avoid the allocation.",
  "Add a null guard here.",
  "Trace why this call is slow.",
  "Summarize what this function does.",
  "Wire up the new config flag.",
];
const GIST_POOL = [
  "Looked at the module; nothing unusual so far.",
  "Updated the handler with structured logging.",
  "Ran the suite; will report results.",
  "Refactored the loop, allocation removed.",
  "Added the guard clause.",
  "Traced the slow path to the serializer.",
  "Here is the summary of the function.",
  "Wired the flag through the config loader.",
];

let clock = Date.parse("2026-02-01T00:00:00.000Z");
const ts = () => new Date((clock += 1500)).toISOString();
let seq = 0;
const uid = (tag) => `k${String(++seq).padStart(5, "0")}-${tag}`;

/** Generates the fixture's JSONL lines. Exported so the conformance suite
 * can independently recompute expectations (turn count, node count) from
 * the exact same deterministic shape without re-running this generator. */
export function generateLines() {
  const lines = [];
  let lastUuid = null;
  const push = (obj) => lines.push(JSON.stringify(obj));

  for (let turn = 0; turn < TURN_COUNT; turn++) {
    const uUuid = uid("u");
    push({
      type: "user",
      uuid: uUuid,
      parentUuid: lastUuid,
      sessionId: SESSION_ID,
      cwd: CWD,
      timestamp: ts(),
      isSidechain: false,
      message: { role: "user", content: `${ASK_POOL[randInt(ASK_POOL.length)]} (turn ${turn})` },
    });
    lastUuid = uUuid;

    const nTools = randInt(5); // 0..4 parallel tool_use blocks
    const aUuid = uid("a");
    const blocks = [{ type: "text", text: GIST_POOL[randInt(GIST_POOL.length)] }];
    const toolIds = [];
    for (let t = 0; t < nTools; t++) {
      const toolId = uid("t");
      toolIds.push(toolId);
      const tool = TOOLS[randInt(TOOLS.length)];
      const file = FILE_POOL[randInt(FILE_POOL.length)];
      blocks.push({
        type: "tool_use",
        id: toolId,
        name: tool,
        input: tool === "Bash" ? { command: `npm test -- ${file}` } : { file_path: file },
      });
    }
    push({
      type: "assistant",
      uuid: aUuid,
      parentUuid: lastUuid,
      sessionId: SESSION_ID,
      cwd: CWD,
      timestamp: ts(),
      isSidechain: false,
      message: { role: "assistant", content: blocks },
    });
    lastUuid = aUuid;

    for (const toolId of toolIds) {
      const rUuid = uid("r");
      push({
        type: "user",
        uuid: rUuid,
        parentUuid: aUuid,
        sessionId: SESSION_ID,
        cwd: CWD,
        timestamp: ts(),
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }],
        },
        toolUseResult: { success: true },
      });
      lastUuid = rUuid;
    }

    // Every 4th turn: a wrap-up assistant text line closing the turn (no
    // tools) — exercises multi-line turns beyond a single prompt/assistant
    // pair without opening a new turn (wrap-up is not a prompt node).
    if (turn % 4 === 3) {
      const wUuid = uid("w");
      push({
        type: "assistant",
        uuid: wUuid,
        parentUuid: lastUuid,
        sessionId: SESSION_ID,
        cwd: CWD,
        timestamp: ts(),
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done with this one; moving on." }],
        },
      });
      lastUuid = wUuid;
    }
  }
  return lines;
}

// Only write the fixture file when run directly (not when imported for its
// exports by the conformance suite).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const lines = generateLines();
  const out = lines.map((l) => l + "\n").join("");
  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "thousand-steps.jsonl");
  fs.writeFileSync(outPath, out, "utf8");
  process.stderr.write(
    `[gen-thousand] wrote ${lines.length} lines, ${TURN_COUNT} turns -> ${outPath}\n`,
  );
}
