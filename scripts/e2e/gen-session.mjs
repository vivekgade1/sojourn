#!/usr/bin/env node
/**
 * Scenario session generator — drives an ISOLATED Sojourn daemon through a
 * staged, full-coverage Claude-style session.
 *
 * Unlike a static fixture, this mutates the project directory BETWEEN turns
 * and triggers a hook re-scan after each stage, so every turn gets its own
 * snapshot and the turn-scoped flag grounding is exercised for real.
 *
 * V2 scenarios: a flag-storm session (budgets/digests, staged as ONE batch),
 * a decision-memory turn (FTS + node_files search), a synthetic-compaction
 * session (exact-rewind refusal), and a flag-free session (gate exit 0).
 *
 * Env: E2E_PORT (daemon), E2E_PROJECT (project root), E2E_CLAUDE_DIR
 * (CLAUDE_CONFIG_DIR the daemon watches), E2E_OUT (manifest path).
 */
import fs from "node:fs/promises";
import path from "node:path";

const PORT = process.env.E2E_PORT ?? "4199";
const PROJECT = process.env.E2E_PROJECT;
const CLAUDE_DIR = process.env.E2E_CLAUDE_DIR;
const OUT = process.env.E2E_OUT;
if (!PROJECT || !CLAUDE_DIR || !OUT) {
  console.error("E2E_PROJECT, E2E_CLAUDE_DIR, E2E_OUT are required");
  process.exit(2);
}
const BASE = `http://localhost:${PORT}`;

const SESSION_A = "e2e-scenarios-0001";
const SESSION_B = "e2e-second-0002";
const SESSION_C = "e2e-storm-0003"; // V2: flag-storm (budgets/digests)
const SESSION_D = "e2e-compact-0004"; // V2: synthetic compaction boundary (rewind refusal)
const SESSION_E = "e2e-clean-0005"; // V2: flag-free session (soj gate exit 0)

let clock = Date.parse("2026-07-11T10:00:00.000Z");
const ts = () => new Date((clock += 4000)).toISOString();
let seq = 0;
const uid = (tag) => `e2e-${tag}-${String(++seq).padStart(3, "0")}`;

function transcriptPath(sessionId) {
  return path.join(CLAUDE_DIR, "projects", "-e2e-proj", `${sessionId}.jsonl`);
}

/** Builds JSONL lines with the exact field shape the Claude parser consumes. */
class Session {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.lines = [];
    this.lastUuid = null;
  }
  user(text, { uuid = uid("u") } = {}) {
    this.lines.push(
      JSON.stringify({
        type: "user",
        uuid,
        parentUuid: this.lastUuid,
        sessionId: this.sessionId,
        cwd: PROJECT,
        timestamp: ts(),
        message: { role: "user", content: text },
      }),
    );
    this.lastUuid = uuid;
    return uuid;
  }
  assistant(blocks, { uuid = uid("a") } = {}) {
    this.lines.push(
      JSON.stringify({
        type: "assistant",
        uuid,
        parentUuid: this.lastUuid,
        sessionId: this.sessionId,
        cwd: PROJECT,
        timestamp: ts(),
        message: { role: "assistant", content: blocks },
      }),
    );
    this.lastUuid = uuid;
    return uuid;
  }
  toolResults(results, { uuid = uid("r") } = {}) {
    this.lines.push(
      JSON.stringify({
        type: "user",
        uuid,
        parentUuid: this.lastUuid,
        sessionId: this.sessionId,
        cwd: PROJECT,
        timestamp: ts(),
        message: {
          role: "user",
          content: results.map(({ toolUseId, content }) => ({
            type: "tool_result",
            tool_use_id: toolUseId,
            content,
          })),
        },
      }),
    );
    this.lastUuid = uuid;
    return uuid;
  }
  /** Pushes a raw transcript line verbatim (e.g. a `type:"summary"`
   * compaction marker). Does NOT advance lastUuid — the parser skips these
   * lines, so the conversation chain must flow around them. */
  raw(record) {
    this.lines.push(JSON.stringify(record));
  }
  async flush() {
    const file = transcriptPath(this.sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Atomic write (tmp + rename, non-.jsonl suffix the watcher ignores):
    // the daemon's chokidar watcher must never observe a HALF-written
    // transcript, or a multi-claim batch (e.g. the flag storm, which MUST
    // land in one ingest batch for budget semantics) could split in two.
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, this.lines.map((l) => l + "\n").join(""), "utf8");
    await fs.rename(tmp, file);
  }
}

async function rescan(sessionId) {
  const res = await fetch(`${BASE}/api/hooks/claude`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath(sessionId),
      cwd: PROJECT,
      hook_event_name: "PostToolUse",
    }),
  });
  if (res.status !== 200) throw new Error(`hook rescan -> ${res.status}`);
}

async function nodeCount(projectId) {
  const res = await fetch(`${BASE}/api/projects/${projectId}/graph`);
  if (res.status !== 200) return -1;
  return (await res.json()).nodes.length;
}

async function projectId() {
  const res = await fetch(`${BASE}/api/projects`);
  const projects = await res.json();
  const hit = projects.find((p) => path.resolve(p.root) === path.resolve(PROJECT));
  return hit?.id ?? null;
}

/**
 * Waits until the graph holds at least `min` nodes AND at least `minSnaps`
 * batch snapshots have been ATTACHED. Waiting on node count alone is a
 * race: nodes become visible at upsert time, but the batch snapshot lands
 * asynchronously afterwards — mutating the project disk for the next turn
 * in that window bleeds next-turn edits into the previous turn's snapshot.
 */
async function waitForNodes(min, minSnaps, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const pid = await projectId();
    if (pid !== null) {
      const res = await fetch(`${BASE}/api/projects/${pid}/graph`);
      if (res.status === 200) {
        const g = await res.json();
        const snaps = g.nodes.filter((n) => n.snapshotRef).length;
        if (g.nodes.length >= min && snaps >= minSnaps) {
          return { projectId: pid, nodes: g.nodes.length, snaps };
        }
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${min} nodes / ${minSnaps} snapshots (project ${pid})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

const write = (rel, content) =>
  fs.mkdir(path.join(PROJECT, path.dirname(rel)), { recursive: true }).then(() =>
    fs.writeFile(path.join(PROJECT, rel), content, "utf8"),
  );

async function main() {
  const a = new Session(SESSION_A);
  const manifest = {
    sessionA: SESSION_A,
    sessionB: SESSION_B,
    project: PROJECT,
    claudeDir: CLAUDE_DIR,
    scenarios: {},
  };
  let expectedNodes = 0;
  let expectedSnaps = 0;
  const stage = async (session, label, expectAdded) => {
    await session.flush();
    await rescan(session.sessionId);
    expectedNodes += expectAdded;
    expectedSnaps += 1; // exactly one snapshot per ingested batch
    const { projectId: pid } = await waitForNodes(expectedNodes, expectedSnaps);
    manifest.projectId = pid;
    console.error(`[gen] stage ok: ${label} (>= ${expectedNodes} nodes, ${expectedSnaps} snaps)`);
  };

  // ---- Turn 1: setup — establishes the first snapshot ----
  await write("src/app.py", "def main():\n    return 1\n");
  await write("package.json", JSON.stringify({ name: "e2e-proj", dependencies: {} }, null, 2));
  a.user("Create the app skeleton");
  const t1tool = uid("t");
  a.assistant([
    { type: "text", text: "Creating the skeleton now." },
    { type: "tool_use", id: t1tool, name: "Write", input: { file_path: "src/app.py" } },
  ]);
  a.toolResults([{ toolUseId: t1tool, content: "ok" }]);
  await stage(a, "turn1 setup", 4);

  // ---- Turn 2: TRUTHFUL edit claim (must NOT flag) ----
  await write("src/app.py", "def main():\n    return 2  # fixed\n");
  a.user("Fix the return value bug");
  const t2tool = uid("t");
  a.assistant([
    { type: "tool_use", id: t2tool, name: "Edit", input: { file_path: "src/app.py" } },
  ]);
  a.toolResults([{ toolUseId: t2tool, content: "edited" }]);
  manifest.scenarios.truthfulEdit = {
    nodeId: `claude:${a.assistant([
      { type: "text", text: "I updated `src/app.py` to fix the return value bug." },
    ])}`,
    expect: { flagKind: "edit_claim_mismatch", present: false },
  };
  await stage(a, "turn2 truthful edit", 4);

  // ---- Turn 3: FALSE edit claim (must flag, high) ----
  a.user("Now update the auth module");
  manifest.scenarios.falseEdit = {
    nodeId: `claude:${a.assistant([
      { type: "text", text: "I updated `src/auth.py` to handle refresh tokens." },
    ])}`,
    expect: { flagKind: "edit_claim_mismatch", present: true, minConfidence: "high" },
  };
  await stage(a, "turn3 false edit claim", 2);

  // ---- Turn 4: package hallucination ----
  await write(
    "src/deps.py",
    "import totally_unreal_pkg_zx91\n\ndef use():\n    return totally_unreal_pkg_zx91.go()\n",
  );
  a.user("Add the dependency import");
  const t4tool = uid("t");
  a.assistant([
    { type: "tool_use", id: t4tool, name: "Write", input: { file_path: "src/deps.py" } },
  ]);
  a.toolResults([{ toolUseId: t4tool, content: "ok" }]);
  manifest.scenarios.packageHallucination = {
    nodeId: `claude:${a.assistant([
      { type: "text", text: "Added the import in `src/deps.py` using the new package." },
    ])}`,
    expect: { flagKind: "package_hallucination", present: true, networkDependent: true },
  };
  await stage(a, "turn4 package hallucination", 4);

  // ---- Turn 5: missing file reference ----
  a.user("Where is the config documented?");
  manifest.scenarios.missingFileRef = {
    nodeId: `claude:${a.assistant([
      { type: "text", text: "The defaults are defined in `src/missing_config.py` next to the loader." },
    ])}`,
    expect: { flagKind: "file_ref_missing", present: true },
  };
  await stage(a, "turn5 missing file ref", 2);

  // ---- Turn 6: missing symbol ----
  a.user("How is throttling handled?");
  manifest.scenarios.missingSymbol = {
    nodeId: `claude:${a.assistant([
      { type: "text", text: "The function `frobnicate()` in `src/app.py` handles all throttling." },
    ])}`,
    expect: { flagKind: "symbol_not_found", present: true },
  };
  await stage(a, "turn6 missing symbol", 2);

  // ---- Turn 7: "tests pass" with NO observed run ----
  a.user("Are we good to ship?");
  manifest.scenarios.testClaimNoRun = {
    nodeId: `claude:${a.assistant([{ type: "text", text: "All tests pass." }])}`,
    expect: { flagKind: "test_claim_unverified", present: true },
  };
  await stage(a, "turn7 test claim no run", 2);

  // ---- Turn 8: "tests pass" with a FAILING observed run ----
  a.user("Run the tests and confirm");
  const t8tool = uid("t");
  a.assistant([
    { type: "tool_use", id: t8tool, name: "Bash", input: { command: "npm test" } },
  ]);
  a.toolResults([{ toolUseId: t8tool, content: "Tests: 2 failed, 3 passed, 5 total" }]);
  manifest.scenarios.testClaimFailingRun = {
    nodeId: `claude:${a.assistant([{ type: "text", text: "All tests pass." }])}`,
    expect: { flagKind: "test_claim_unverified", present: true, minConfidence: "high" },
  };
  await stage(a, "turn8 test claim failing run", 4);

  // ---- Turn 9: truthful "tests pass" WITH a passing run (must NOT flag) ----
  a.user("Run them again after the fix");
  const t9tool = uid("t");
  a.assistant([
    { type: "tool_use", id: t9tool, name: "Bash", input: { command: "npx vitest run" } },
  ]);
  a.toolResults([{ toolUseId: t9tool, content: "Tests  5 passed (5)\nDuration 1.2s" }]);
  manifest.scenarios.testClaimPassingRun = {
    nodeId: `claude:${a.assistant([{ type: "text", text: "All tests pass." }])}`,
    expect: { flagKind: "test_claim_unverified", present: false },
  };
  await stage(a, "turn9 truthful test claim", 4);

  // ---- Turn 10: auto-resolve — actually edit auth.py like turn 3 claimed ----
  await write("src/auth.py", "def refresh_token():\n    return True\n");
  a.user("Actually update the auth module now");
  const t10tool = uid("t");
  a.assistant([
    { type: "tool_use", id: t10tool, name: "Write", input: { file_path: "src/auth.py" } },
  ]);
  a.toolResults([{ toolUseId: t10tool, content: "ok" }]);
  manifest.scenarios.autoResolve = {
    nodeId: `claude:${a.assistant([
      { type: "text", text: "I updated `src/auth.py` to handle refresh tokens for real this time." },
    ])}`,
    resolvesNodeId: manifest.scenarios.falseEdit.nodeId,
    expect: { earlierFlagAutoResolved: true },
  };
  await stage(a, "turn10 auto-resolve", 4);

  // ---- Turn 11: parallel tool_use siblings ----
  a.user("Read both files in parallel");
  const p1 = uid("t");
  const p2 = uid("t");
  const parallelAssistant = a.assistant([
    { type: "text", text: "Reading both files." },
    { type: "tool_use", id: p1, name: "Read", input: { file_path: "src/app.py" } },
    { type: "tool_use", id: p2, name: "Read", input: { file_path: "src/auth.py" } },
  ]);
  a.toolResults([
    { toolUseId: p1, content: "def main..." },
    { toolUseId: p2, content: "def refresh_token..." },
  ]);
  manifest.scenarios.parallelSiblings = {
    textNodeId: `claude:${parallelAssistant}`,
    toolNodeIds: [`claude:${p1}`, `claude:${p2}`],
    expect: { siblingsShareParent: true },
  };
  await stage(a, "turn11 parallel siblings", 6);

  // ---- Turn 12 (V2): distinctive gist + a fresh file, for decision-memory
  // search (FTS q= hit on the gist, file= hit via the turn's node_files
  // index) and as the EXACT-rewind target (clean ancestor chain).
  // The text is deliberately claim-free: "lives in" is not an edit verb,
  // and `src/walrus.py` exists on disk, so no flag fires here.
  await write("src/walrus.py", "WALTZ = True\n");
  const walrusPrompt = a.user("Where does the walrus dance?");
  const walrusNode = a.assistant([
    { type: "text", text: "The dance config lives in `src/walrus.py` and hums quietly." },
  ]);
  manifest.scenarios.walrusSearch = {
    promptNodeId: `claude:${walrusPrompt}`,
    nodeId: `claude:${walrusNode}`,
    file: "src/walrus.py",
    q: "walrus",
  };
  manifest.scenarios.rewindExact = {
    nodeId: `claude:${walrusNode}`,
    sessionId: SESSION_A,
  };
  // Session A turn count, for the /health check: turns 1-12 are prompts.
  manifest.scenarios.healthA = { turns: 12 };
  await stage(a, "turn12 walrus search turn", 2);

  // ---- Session B: a tiny second journey ----
  const b = new Session(SESSION_B);
  b.user("Quick second session");
  manifest.scenarios.secondSession = {
    nodeId: `claude:${b.assistant([{ type: "text", text: "Hello from session B." }])}`,
    expect: { sessions: 2 },
  };
  await stage(b, "session B", 2);

  // ---- Session C (V2): FLAG STORM — budgets + digests.
  // The storm turn MUST land in ONE staged batch: flags only run on NEW
  // nodes per ingest batch, so splitting it would budget each fragment
  // separately and never overflow into a digest.
  const c = new Session(SESSION_C);
  // Setup turn first: the storm turn needs a snapshot at/before its prompt
  // (turn-base grounding) or the edit-claim check stays silent. The setup
  // turn is TOOL-ONLY (no assistant TEXT node): a session's first turn has
  // no grounded base, so its diff is the whole tree — a text assistant here
  // would pick up a network-dependent package_hallucination flag from
  // src/deps.py and make the storm session's health counts flaky.
  await write("src/storm_setup.txt", "storm rig\n");
  c.user("Prepare the storm rig");
  const cSetupTool = uid("t");
  c.assistant([
    { type: "tool_use", id: cSetupTool, name: "Write", input: { file_path: "src/storm_setup.txt" } },
  ]);
  c.toolResults([{ toolUseId: cSetupTool, content: "ok" }]);
  await stage(c, "storm setup turn", 3);

  const stormPrompt = c.user("Unleash the flag storm");
  // 8 IDENTICAL false edit claims (same claimed file token): per-turn dedup
  // collapses them to ONE kept flag — identical claims never digest.
  const stormEditNodeIds = [];
  for (let i = 0; i < 8; i++) {
    stormEditNodeIds.push(
      `claude:${c.assistant([
        { type: "text", text: "I updated `src/storm.py` to stabilize the reactor loop." },
      ])}`,
    );
  }
  // 5 DISTINCT false claims of another kind (file_ref_missing, budget 3):
  // 3 kept individually + ONE digest carrying suppressedCount = 2. The file
  // names are digit-free so the digest evidence stays provably count-free.
  const stormRefFiles = [
    "src/ref_alpha.py",
    "src/ref_beta.py",
    "src/ref_gamma.py",
    "src/ref_delta.py",
    "src/ref_epsilon.py",
  ];
  const stormDistinctNodeIds = stormRefFiles.map(
    (f) =>
      `claude:${c.assistant([
        { type: "text", text: `The retry policy is documented in \`${f}\` for operators.` },
      ])}`,
  );
  manifest.scenarios.flagStorm = {
    sessionId: SESSION_C,
    promptNodeId: `claude:${stormPrompt}`,
    editNodeIds: stormEditNodeIds,
    distinctNodeIds: stormDistinctNodeIds,
    // The digest lands on the node producing the LAST flag of its group.
    digestOwnerNodeId: stormDistinctNodeIds[stormRefFiles.length - 1],
    expect: {
      turns: 2,
      editKept: 1,
      distinctKind: "file_ref_missing",
      distinctBudget: 3,
      digestCount: 1,
      digestSuppressed: 2,
      // 1 deduped edit claim + 3 kept file refs + 1 digest:
      activeVerified: 5,
    },
  };
  await stage(c, "storm turn (ONE batch)", 1 + 8 + 5);

  // ---- Session E (V2): a genuinely FLAG-FREE session, for `soj gate`'s
  // exit-0 path. Tool-only (no assistant TEXT node), because flag checks
  // only run on assistant text nodes and a first-turn text assistant would
  // pick up the network-dependent package_hallucination flag from the
  // whole-tree diff (no grounded turn base in a fresh session). Staged
  // BEFORE session D so D's tail stays the newest snapshotted node (the
  // restore/harvest/aliasing origin, whose rewind companion is the honest
  // tip fallback — it never writes a synthesized transcript mid-check).
  const e = new Session(SESSION_E);
  e.user("Quiet bookkeeping run");
  const eTool = uid("t");
  e.assistant([
    { type: "tool_use", id: eTool, name: "Read", input: { file_path: "src/app.py" } },
  ]);
  e.toolResults([{ toolUseId: eTool, content: "def main..." }]);
  manifest.scenarios.cleanSession = { sessionId: SESSION_E };
  await stage(e, "clean session (gate exit 0)", 3);

  // ---- Session D (V2): synthetic compaction boundary. A `type:"summary"`
  // line sits INSIDE the ancestor chain's line range of the final node, so
  // an exact rewind of that node must REFUSE (mode "tip" + refusedReason).
  const d = new Session(SESSION_D);
  d.user("Start the long journey");
  const dA1 = d.assistant([{ type: "text", text: "Beginning the work." }]);
  d.raw({
    type: "summary",
    summary: "Previous conversation compacted",
    leafUuid: dA1,
    timestamp: ts(),
  });
  d.user("Continue after the compaction");
  const dA2 = d.assistant([{ type: "text", text: "Continuing with reconstructed context." }]);
  manifest.scenarios.compaction = {
    sessionId: SESSION_D,
    targetNodeId: `claude:${dA2}`,
    expect: {
      mode: "tip",
      resumeCommand: `claude --resume ${SESSION_D} --fork-session`,
    },
  };
  await stage(d, "compaction session", 4);

  // Let the final batch's flag pass settle before the checker reads flags.
  await new Promise((r) => setTimeout(r, 1500));

  manifest.expectedMinNodes = expectedNodes;
  await fs.writeFile(OUT, JSON.stringify(manifest, null, 2), "utf8");
  console.error(`[gen] manifest written: ${OUT}`);
}

main().catch((err) => {
  console.error("[gen] FAILED:", err);
  process.exit(1);
});
