#!/usr/bin/env node
/**
 * Demo helper: runs one synthetic Claude turn whose `cwd` is a RESTORED
 * WORKTREE, so the daemon (a) aliases the session into the origin project
 * via `.sojourn-restore.json` and (b) takes a snapshot of the WORKTREE tree
 * — which at that moment contains Sojourn's own `.sojourn-restore.json` and
 * `.sojourn-harvest.patch` artifacts.
 *
 * That snapshot is what the snapshot-exclude demo inspects: the artifacts
 * are on disk in the worktree, and must NOT appear in the captured tree.
 *
 * Env: DEMO_PORT, DEMO_CLAUDE_DIR, DEMO_WORKTREE, DEMO_SESSION_ID.
 * Prints the snapshotted node id on stdout.
 */
import fs from "node:fs/promises";
import path from "node:path";

const PORT = process.env.DEMO_PORT;
const CLAUDE_DIR = process.env.DEMO_CLAUDE_DIR;
const WORKTREE = process.env.DEMO_WORKTREE;
const SESSION = process.env.DEMO_SESSION_ID ?? "demo-worktree-0006";
if (!PORT || !CLAUDE_DIR || !WORKTREE) {
  console.error("DEMO_PORT, DEMO_CLAUDE_DIR, DEMO_WORKTREE are required");
  process.exit(2);
}
const BASE = `http://localhost:${PORT}`;

// Same encoded-project subdir the e2e generator uses, so both sessions live
// side by side exactly as Claude Code would lay them out.
const dir = path.join(CLAUDE_DIR, "projects", "-e2e-proj");
const file = path.join(dir, `${SESSION}.jsonl`);

let clock = Date.parse("2026-07-11T12:00:00.000Z");
const ts = () => new Date((clock += 4000)).toISOString();

const lines = [
  {
    type: "user",
    uuid: `${SESSION}-u-1`,
    parentUuid: null,
    sessionId: SESSION,
    cwd: WORKTREE,
    timestamp: ts(),
    message: { role: "user", content: "Take stock of the restored worktree" },
  },
  {
    type: "assistant",
    uuid: `${SESSION}-a-1`,
    parentUuid: `${SESSION}-u-1`,
    sessionId: SESSION,
    cwd: WORKTREE,
    timestamp: ts(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "The worktree is in the restored state." }],
    },
  },
];

await fs.mkdir(dir, { recursive: true });
// Atomic write: the watcher must never see a half-written transcript.
const tmp = `${file}.tmp-${process.pid}`;
await fs.writeFile(tmp, lines.map((l) => JSON.stringify(l) + "\n").join(""), "utf8");
await fs.rename(tmp, file);

const res = await fetch(`${BASE}/api/hooks/claude`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    session_id: SESSION,
    transcript_path: file,
    cwd: WORKTREE,
    hook_event_name: "PostToolUse",
  }),
});
if (res.status !== 200) {
  console.error(`hook rescan -> ${res.status}`);
  process.exit(1);
}

// Wait for the node AND its snapshot to land (nodes appear at upsert time;
// the batch snapshot attaches asynchronously afterwards).
const deadline = Date.now() + 30000;
for (;;) {
  const projects = await (await fetch(`${BASE}/api/projects`)).json();
  for (const p of projects) {
    const g = await (await fetch(`${BASE}/api/projects/${p.id}/graph`)).json();
    const hit = g.nodes.find(
      (n) => n.sessionId === SESSION && n.kind === "assistant" && n.snapshotRef,
    );
    if (hit) {
      console.log(JSON.stringify({ projectId: p.id, nodeId: hit.id, snapshotRef: hit.snapshotRef }));
      process.exit(0);
    }
  }
  if (Date.now() > deadline) {
    console.error(`timed out waiting for a snapshotted node in session ${SESSION}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 300));
}
