#!/usr/bin/env node
/**
 * Adapter conformance suite — the invariant corpus every adapter must
 * survive. Runs the BUILT dists (prerequisite: `npm run build:node`)
 * against the golden fixtures in scripts/e2e/fixtures/ and asserts:
 *
 *   - parseSessionJsonl / parseOpenCodeMessages never throw, even on
 *     malformed/broken/adversarial input
 *   - a fixture with usable content always yields node count > 0
 *   - parallel tool calls fan out as SIBLINGS sharing exactly one parent
 *     (never chained tool-under-tool, never dropped — the project's
 *     "no parallel-tool-call sibling-drop" invariant, CLAUDE.md)
 *   - chronological turn grouping — the MINIMAL rule from
 *     packages/web/src/turns.ts, reimplemented here (this is a plain node
 *     script; browser-facing UI code is never imported into it) — matches
 *     an expectation computed by a SECOND, from-scratch scan of the raw
 *     fixture text, independent of the parser under test
 *   - broken/orphaned parentUuid references still yield nodes: resolution
 *     degrades to parentId=null rather than throwing or losing data
 *   - a mid-chain compaction boundary REFUSES exact rewind — the flagship
 *     REFUSAL invariant, probed directly against the built
 *     adapter-claude/dist/rewind.js (rewind.ts is stable). Asserted via a
 *     hard import: any throw or unrecognized return shape is a FAILURE.
 *
 * Usage: npm run build:node && node scripts/e2e/conformance.mjs
 * Exits non-zero iff any check FAILs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES = path.join(__dirname, "fixtures");

const CLAUDE_DIST = path.join(REPO_ROOT, "packages", "adapter-claude", "dist", "index.js");
const OPENCODE_DIST = path.join(REPO_ROOT, "packages", "adapter-opencode", "dist", "index.js");
const REWIND_DIST = path.join(REPO_ROOT, "packages", "adapter-claude", "dist", "rewind.js");

for (const p of [CLAUDE_DIST, OPENCODE_DIST, REWIND_DIST]) {
  if (!fs.existsSync(p)) {
    console.error(`[conformance] missing built dist: ${p}`);
    console.error("[conformance] run `npm run build:node` first");
    process.exit(2);
  }
}

const { parseSessionJsonl } = await import(CLAUDE_DIST);
const { parseOpenCodeMessages } = await import(OPENCODE_DIST);
const { planRewind } = await import(REWIND_DIST);

// ---------------------------------------------------------------------------
// results table
// ---------------------------------------------------------------------------
const results = [];
function pass(name, detail) {
  results.push({ name, status: "PASS", detail });
}
function fail(name, detail) {
  results.push({ name, status: "FAIL", detail });
}
function skip(name, detail) {
  results.push({ name, status: "SKIP", detail });
}
function assertOk(cond, name, detail) {
  cond ? pass(name, detail) : fail(name, detail ?? "assertion failed");
}

// ---------------------------------------------------------------------------
// chronological turn grouping — MINIMAL reimplementation of the rule in
// packages/web/src/turns.ts. Rule: group nodes by session, sort
// chronologically (timestamp, then id as tiebreak), and open a new turn at
// every node with kind === "prompt" once the current group is non-empty.
// ---------------------------------------------------------------------------
function chronoTurnCounts(nodes) {
  const bySession = new Map();
  for (const n of nodes) {
    const list = bySession.get(n.sessionId) ?? [];
    list.push(n);
    bySession.set(n.sessionId, list);
  }
  const perSession = new Map();
  for (const [sessionId, list] of bySession) {
    const ordered = [...list].sort((a, b) =>
      a.timestamp === b.timestamp ? (a.id < b.id ? -1 : 1) : a.timestamp < b.timestamp ? -1 : 1,
    );
    let turns = 0;
    let currentLen = 0;
    for (const node of ordered) {
      if (node.kind === "prompt" && currentLen > 0) {
        turns++;
        currentLen = 0;
      }
      currentLen++;
    }
    if (currentLen > 0) turns++;
    perSession.set(sessionId, turns);
  }
  return perSession;
}

function totalTurns(nodes) {
  return [...chronoTurnCounts(nodes).values()].reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// independent raw-text scans — a SECOND, from-scratch implementation of
// "what should this fixture produce", reading directly off the JSONL/JSON
// text rather than through the parser under test. Drift between this and
// the parser's actual output is a real regression signal.
// ---------------------------------------------------------------------------
function isRec(v) {
  return typeof v === "object" && v !== null;
}

/** Scans a raw Claude transcript, independent of parseSessionJsonl. */
function scanClaudeRaw(raw) {
  let promptLines = 0;
  let expectedNodes = 0;
  const multiToolLines = []; // { toolIds: string[] }
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRec(rec)) continue;
    if (rec.type === "summary" || rec.type === "system") continue;
    if (rec.isSidechain === true) continue;

    if (rec.type === "user") {
      const content = isRec(rec.message) ? rec.message.content : undefined;
      if (typeof content === "string") {
        promptLines++;
        expectedNodes++;
      } else if (Array.isArray(content)) {
        const toolResults = content.filter((b) => isRec(b) && b.type === "tool_result");
        if (toolResults.length > 0) {
          expectedNodes += toolResults.length;
        } else {
          promptLines++;
          expectedNodes++;
        }
      }
    } else if (rec.type === "assistant") {
      const content = isRec(rec.message) ? rec.message.content : undefined;
      const blocks = Array.isArray(content)
        ? content.filter(isRec)
        : typeof content === "string"
          ? [{ type: "text", text: content }]
          : [];
      const toolIds = [];
      for (const b of blocks) {
        if (b.type === "text") {
          expectedNodes++;
        } else if (b.type === "tool_use" && typeof b.id === "string" && b.id.length > 0) {
          expectedNodes++;
          toolIds.push(b.id);
        }
      }
      if (toolIds.length >= 2) multiToolLines.push({ toolIds });
    }
  }
  return { promptLines, expectedNodes, multiToolLines };
}

/** Scans a raw OpenCode messages array, independent of parseOpenCodeMessages. */
function scanOpenCodeRaw(messages) {
  let promptLines = 0;
  let expectedNodes = 0;
  const multiToolParts = []; // { callIds: string[] }
  for (const entry of messages) {
    if (!isRec(entry) || !isRec(entry.info) || !Array.isArray(entry.parts)) continue;
    const role = entry.info.role;
    if (role === "user") {
      const textPart = entry.parts.find(
        (p) => isRec(p) && p.type === "text" && typeof p.text === "string" && typeof p.id === "string" && p.id.length > 0,
      );
      if (textPart) {
        promptLines++;
        expectedNodes++;
      }
    } else if (role === "assistant") {
      const callIds = [];
      for (const p of entry.parts) {
        if (!isRec(p)) continue;
        if (p.type === "text" && typeof p.id === "string" && p.id.length > 0) {
          expectedNodes++;
        } else if (p.type === "tool" && typeof p.callID === "string" && p.callID.length > 0) {
          expectedNodes++;
          callIds.push(p.callID);
          const status = isRec(p.state) ? p.state.status : undefined;
          if (status === "completed" || status === "error") expectedNodes++;
        }
      }
      if (callIds.length >= 2) multiToolParts.push({ callIds });
    }
  }
  return { promptLines, expectedNodes, multiToolParts };
}

function byNativeUuid(nodes) {
  const map = new Map();
  for (const n of nodes) map.set(n.meta?.nativeUuid, n);
  return map;
}

/** Every group of parallel tool-ish node ids must resolve to exactly one shared parentId. */
function checkFanOut(groups, nodesByUuid) {
  for (const { ids } of groups) {
    const parents = new Set();
    for (const id of ids) {
      const node = nodesByUuid.get(id);
      if (!node) return { ok: false, detail: `node missing for id ${id}` };
      parents.add(node.parentId);
    }
    if (parents.size !== 1) {
      return { ok: false, detail: `ids [${ids.join(",")}] have ${parents.size} distinct parents` };
    }
  }
  return { ok: true, detail: `${groups.length} multi-tool group(s) checked` };
}

// ---------------------------------------------------------------------------
// Claude fixtures
// ---------------------------------------------------------------------------
const claudeFixtures = ["orphaned-parentage.jsonl", "compaction-session.jsonl", "thousand-steps.jsonl"];
let compactionBatch = null; // stashed for the rewind probe below

for (const fixtureName of claudeFixtures) {
  const fixturePath = path.join(FIXTURES, fixtureName);
  const raw = fs.readFileSync(fixturePath, "utf8");

  let batch;
  try {
    batch = parseSessionJsonl(fixturePath, raw);
    pass(`${fixtureName}: parseSessionJsonl does not throw`);
  } catch (err) {
    fail(`${fixtureName}: parseSessionJsonl does not throw`, err?.stack ?? String(err));
    continue;
  }

  assertOk(
    batch !== null && batch.nodes.length > 0,
    `${fixtureName}: node count > 0`,
    `got ${batch?.nodes?.length ?? 0}`,
  );
  if (!batch) continue;
  if (fixtureName === "compaction-session.jsonl") compactionBatch = { batch, raw, fixturePath };

  const nodesByUuid = byNativeUuid(batch.nodes);
  const rawScan = scanClaudeRaw(raw);

  const fanOut = checkFanOut(
    rawScan.multiToolLines.map((g) => ({ ids: g.toolIds })),
    nodesByUuid,
  );
  assertOk(
    fanOut.ok && rawScan.multiToolLines.length > 0,
    `${fixtureName}: multi-tool assistant lines fan out to ONE shared parent (sibling retention)`,
    fanOut.detail,
  );

  const computedTurns = totalTurns(batch.nodes);
  assertOk(
    computedTurns === rawScan.promptLines,
    `${fixtureName}: chronological turn count matches independent raw-text expectation`,
    `computed=${computedTurns} expected=${rawScan.promptLines}`,
  );

  assertOk(
    batch.nodes.length === rawScan.expectedNodes,
    `${fixtureName}: node count matches independent raw-text expectation`,
    `got=${batch.nodes.length} expected=${rawScan.expectedNodes}`,
  );
}

// orphan fixture: broken parentage still yields nodes, resolved to null, no crash
{
  const fixturePath = path.join(FIXTURES, "orphaned-parentage.jsonl");
  const raw = fs.readFileSync(fixturePath, "utf8");
  const batch = parseSessionJsonl(fixturePath, raw);
  const nodesByUuid = byNativeUuid(batch.nodes);
  const u1 = nodesByUuid.get("orph-u1"); // raw parentUuid points at a nonexistent ghost id
  const a2 = nodesByUuid.get("orph-a2"); // raw parentUuid points at a different ghost id
  assertOk(
    batch.nodes.length > 0 && !!u1 && u1.parentId === null && !!a2 && a2.parentId === null,
    "orphaned-parentage.jsonl: nodes with broken parentUuid resolve to parentId=null (no crash, no data loss)",
    `nodes=${batch.nodes.length} u1.parentId=${u1?.parentId} a2.parentId=${a2?.parentId}`,
  );
  const ghostResult = nodesByUuid.get("orph-tr-ghost");
  assertOk(
    !!ghostResult && ghostResult.kind === "tool_result" && ghostResult.parentId !== undefined,
    "orphaned-parentage.jsonl: tool_result with an unmatched tool_use_id still lands a node (falls back to line parent)",
    `ghostResult=${JSON.stringify(ghostResult ? { parentId: ghostResult.parentId } : null)}`,
  );
}

// ---------------------------------------------------------------------------
// OpenCode fixture
// ---------------------------------------------------------------------------
{
  const fixturePath = path.join(FIXTURES, "opencode-messages.json");
  const raw = fs.readFileSync(fixturePath, "utf8");
  const messages = JSON.parse(raw);
  const project = { root: "/repo/project", name: "project" };

  let batch = null;
  try {
    batch = parseOpenCodeMessages(messages, "ses_build", project);
    pass("opencode-messages.json: parseOpenCodeMessages does not throw");
  } catch (err) {
    fail("opencode-messages.json: parseOpenCodeMessages does not throw", err?.stack ?? String(err));
  }

  if (batch) {
    assertOk(batch.nodes.length > 0, "opencode-messages.json: node count > 0", `got ${batch.nodes.length}`);

    const nodesByUuid = byNativeUuid(batch.nodes);
    const rawScan = scanOpenCodeRaw(messages);

    const fanOut = checkFanOut(
      rawScan.multiToolParts.map((g) => ({ ids: g.callIds })),
      nodesByUuid,
    );
    assertOk(
      fanOut.ok && rawScan.multiToolParts.length > 0,
      "opencode-messages.json: multi-tool assistant messages fan out to ONE shared parent (sibling retention)",
      fanOut.detail,
    );

    const computedTurns = totalTurns(batch.nodes);
    assertOk(
      computedTurns === rawScan.promptLines,
      "opencode-messages.json: chronological turn count matches independent raw-text expectation",
      `computed=${computedTurns} expected=${rawScan.promptLines}`,
    );

    assertOk(
      batch.nodes.length === rawScan.expectedNodes,
      "opencode-messages.json: node count matches independent raw-text expectation",
      `got=${batch.nodes.length} expected=${rawScan.expectedNodes}`,
    );
  }
}

// ---------------------------------------------------------------------------
// rewind REFUSAL probe — the flagship invariant: a target on the far side of
// a compaction boundary must never be exact-rewound. rewind.ts is STABLE
// (planRewind is hard-imported from REWIND_DIST at startup, above), so this
// asserts DIRECTLY. Any throw or unrecognized return shape is a FAILURE, not
// a skip.
// ---------------------------------------------------------------------------
{
  const NAME = "compaction-session.jsonl: planRewind REFUSES exact mode across a mid-chain summary";
  if (!compactionBatch) {
    fail(NAME, "compaction fixture did not parse; cannot probe rewind");
  } else {
    try {
      const { batch, raw, fixturePath } = compactionBatch;
      const targetNodeId = batch.nodes[batch.nodes.length - 1].id; // far side of the compaction boundary
      const plan = planRewind({
        nodes: batch.nodes,
        targetNodeId,
        rawLines: raw.split("\n"),
        projectsSubdir: path.dirname(fixturePath),
        sessionId: batch.session.id,
      });
      assertOk(
        !!plan &&
          typeof plan === "object" &&
          plan.mode === "tip" &&
          typeof plan.refusedReason === "string" &&
          plan.refusedReason.length > 0,
        NAME,
        `mode=${plan?.mode} refusedReason=${plan?.refusedReason}`,
      );
    } catch (err) {
      fail(NAME, `planRewind threw: ${err?.stack ?? err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const nameWidth = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.status.padEnd(4)} ${r.name.padEnd(nameWidth)}${r.detail ? `  — ${r.detail}` : ""}`);
}
const passedCount = results.filter((r) => r.status === "PASS").length;
const failedCount = results.filter((r) => r.status === "FAIL").length;
const skippedCount = results.filter((r) => r.status === "SKIP").length;
console.log(
  `\n[conformance] ${passedCount}/${results.length} passed, ${failedCount} failed, ${skippedCount} skipped`,
);
process.exit(failedCount > 0 ? 1 : 0);
