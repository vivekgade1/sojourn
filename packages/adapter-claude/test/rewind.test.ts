import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSessionJsonl,
  planRewind,
  executeRewind,
  SojournRewindError,
} from "../src/index.js";
import type { ClaudeRewindPlan } from "../src/index.js";
import type { ChronoNode } from "@sojourn/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "sample-session.jsonl");
const fixtureRaw = readFileSync(fixturePath, "utf8");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Target: the final assistant text node in the fixture (line index 4). */
const TIP_TARGET = "claude:55555555-5555-5555-5555-555555555555";
/** Target: a tool_use block in the MIDDLE of the multi-block assistant line. */
const MID_LINE_TARGET = "claude:toolu_read_001";

function nodesOf(raw: string): ChronoNode[] {
  const batch = parseSessionJsonl("/tmp/fake/session-abc.jsonl", raw);
  expect(batch).not.toBeNull();
  return batch!.nodes;
}

function jsonLinesOf(content: string): Record<string, unknown>[] {
  return content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Every uuid-ish identifier appearing in the original fixture. Tolerant of
 * malformed lines (the fixture contains one on purpose). */
function originalUuids(raw: string): Set<string> {
  const out = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof rec.uuid === "string") out.add(rec.uuid);
    if (typeof rec.parentUuid === "string") out.add(rec.parentUuid);
  }
  return out;
}

function makeGraphNode(params: {
  id: string;
  parentId: string | null;
  kind?: ChronoNode["kind"];
}): ChronoNode {
  return {
    id: params.id,
    parentId: params.parentId,
    kind: params.kind ?? "assistant",
    cli: "claude",
    sessionId: "session-abc",
    projectId: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: "",
    content: null,
    meta: { nativeUuid: params.id.replace(/^claude:/, "") },
  };
}

let projectsSubdir: string;

beforeEach(async () => {
  projectsSubdir = await mkdtemp(path.join(os.tmpdir(), "soj-rewind-"));
});

afterEach(async () => {
  await rm(projectsSubdir, { recursive: true, force: true });
});

function planFixture(overrides?: Partial<Parameters<typeof planRewind>[0]>): ClaudeRewindPlan {
  return planRewind({
    nodes: nodesOf(fixtureRaw),
    targetNodeId: TIP_TARGET,
    rawLines: fixtureRaw.split("\n"),
    projectsSubdir,
    sessionId: "session-abc",
    ...overrides,
  });
}

describe("planRewind", () => {
  it("produces an exact plan for a clean chain", () => {
    const plan = planFixture();
    expect(plan.mode).toBe("exact");
    expect(plan.refusedReason).toBeNull();
    expect(plan.newSessionId).toMatch(UUID_RE);
    expect(plan.transcriptPath).toBe(
      path.join(projectsSubdir, `${plan.newSessionId}.jsonl`),
    );
    expect(plan.resumeCommand).toBe(`claude --resume ${plan.newSessionId}`);
    // chain lines: prompt(0), assistant multi-block(1), tool_result 4444(3),
    // assistant text(4) — PLUS line 2, the tool_result for the OFF-chain
    // toolu_read_001: every tool_use block hosted on an included line must
    // have its tool_result line included too (at or before the target's
    // line), or the synthesized transcript would carry a mid-file dangling
    // tool_use — a shape native transcripts never contain.
    expect(plan.lineIndexes).toEqual([0, 1, 2, 3, 4]);
    expect(plan.expectedKinds).toEqual([
      "prompt",
      "assistant",
      "tool_use",
      "tool_use",
      "tool_result",
      "tool_result",
      "assistant",
    ]);
    // Per-line uuid pins (parallel to lineIndexes): execute asserts these
    // against rawLines before writing anything.
    expect(plan.lineUuids).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
      "55555555-5555-5555-5555-555555555555",
    ]);
    // Parent shape of the chain projection, as indexes into the projection:
    // prompt(root), assistant->prompt, two parallel tool_uses->assistant,
    // each tool_result->its own tool_use, final assistant->second result.
    expect(plan.expectedParentIndexes).toEqual([null, 0, 1, 1, 2, 3, 5]);
  });

  it("allows a tip dangler: a tool_use target whose results fall after the target's line", () => {
    // MID_LINE_TARGET is a tool_use block on line 1; both tool_results live
    // on lines 2-3, AFTER the target's line. A dangling tool_use at the TIP
    // is the native interrupted-turn shape, so no result lines are pulled in.
    const plan = planFixture({ targetNodeId: MID_LINE_TARGET });
    expect(plan.mode).toBe("exact");
    expect(plan.refusedReason).toBeNull();
    expect(plan.lineIndexes).toEqual([0, 1]);
  });

  it("includes the sibling tool_result line of a parallel tool_use turn (no mid-file dangling tool_use)", async () => {
    const plan = planFixture();
    // Line 2 hosts toolu_read_001's result. toolu_read_001 is NOT on the
    // ancestor chain, but its tool_use block sits on included line 1.
    expect(plan.mode).toBe("exact");
    expect(plan.lineIndexes).toContain(2);

    await executeRewind(plan, fixtureRaw.split("\n"));
    const synthesized = jsonLinesOf(await readFile(plan.transcriptPath!, "utf8"));

    // Invariant: every tool_use block in the synthesized transcript has a
    // matching tool_result somewhere after it.
    const useIds: string[] = [];
    const resultIds: string[] = [];
    for (const rec of synthesized) {
      const content = (rec.message as Record<string, unknown> | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "tool_use") useIds.push(block.id as string);
        if (block.type === "tool_result") resultIds.push(block.tool_use_id as string);
      }
    }
    expect(useIds).toHaveLength(2);
    for (const id of useIds) expect(resultIds).toContain(id);
  });

  it("accepts a summary/sidechain line OUTSIDE the chain's line range (after target)", () => {
    // The fixture itself contains a summary line (index 6) and a sidechain
    // line (index 8) AFTER the target's line (index 4): both are outside the
    // chain range and must not trigger a refusal.
    const plan = planFixture();
    expect(plan.mode).toBe("exact");
    expect(plan.refusedReason).toBeNull();
  });

  it("refuses with tip mode when the ancestor chain has an orphan gap", () => {
    const nodes = nodesOf(fixtureRaw).filter(
      (n) => n.id !== "claude:44444444-4444-4444-4444-444444444444",
    );
    const plan = planFixture({ nodes });
    expect(plan.mode).toBe("tip");
    expect(plan.refusedReason).toBe("ancestor chain incomplete (orphaned parentage)");
    expect(plan.newSessionId).toBeNull();
    expect(plan.transcriptPath).toBeNull();
    expect(plan.resumeCommand).toBe("claude --resume session-abc --fork-session");
    expect(plan.lineIndexes).toEqual([]);
    expect(plan.lineUuids).toEqual([]);
  });

  it("refuses when the chain root's line has a non-null unresolvable parentUuid (truncated file)", () => {
    // The parser tolerates orphaned parentage by rooting the node (parentId
    // null), but synthesizing a transcript whose FIRST line was really a
    // mid-conversation line would fabricate history. Refuse instead.
    const mk = (o: Record<string, unknown>) => JSON.stringify(o);
    const raw =
      [
        mk({
          type: "user",
          uuid: "u1",
          parentUuid: "gone-parent-uuid",
          sessionId: "sess-t",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "continue where we left off" },
        }),
        mk({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "sess-t",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
      ].join("\n") + "\n";
    const plan = planRewind({
      nodes: nodesOf(raw),
      targetNodeId: "claude:a1",
      rawLines: raw.split("\n"),
      projectsSubdir,
      sessionId: "sess-t",
    });
    expect(plan.mode).toBe("tip");
    expect(plan.refusedReason).toBe("transcript root has unresolved parent (truncated file?)");
    expect(plan.newSessionId).toBeNull();
    expect(plan.transcriptPath).toBeNull();
    expect(plan.resumeCommand).toBe("claude --resume sess-t --fork-session");

    // Other direction: a true root (parentUuid null) stays exact-eligible.
    const clean = planFixture();
    expect(clean.mode).toBe("exact");
    expect(clean.refusedReason).toBeNull();
  });

  it("refuses when a summary line falls WITHIN the chain's line range", () => {
    const lines = fixtureRaw.split("\n");
    // Insert a summary line between chain lines (inside [0..target] range).
    lines.splice(2, 0, JSON.stringify({ type: "summary", summary: "compacted!", leafUuid: "x" }));
    const raw = lines.join("\n");
    const plan = planFixture({ nodes: nodesOf(raw), rawLines: raw.split("\n") });
    expect(plan.mode).toBe("tip");
    expect(plan.refusedReason).toBe(
      "chain crosses a compaction/summary boundary; exact context cannot be reconstructed",
    );
    expect(plan.newSessionId).toBeNull();
    expect(plan.transcriptPath).toBeNull();
    expect(plan.resumeCommand).toBe("claude --resume session-abc --fork-session");
  });

  it("refuses when an isCompactSummary marker falls within the chain's line range", () => {
    const lines = fixtureRaw.split("\n");
    lines.splice(
      2,
      0,
      JSON.stringify({
        type: "user",
        uuid: "compact-1",
        parentUuid: null,
        sessionId: "session-abc",
        isCompactSummary: true,
        timestamp: "2026-01-01T00:00:01.500Z",
        message: { role: "user", content: "This session is being continued from a previous one..." },
      }),
    );
    const raw = lines.join("\n");
    const plan = planFixture({ nodes: nodesOf(raw), rawLines: raw.split("\n") });
    expect(plan.mode).toBe("tip");
    expect(plan.refusedReason).toBe(
      "chain crosses a compaction/summary boundary; exact context cannot be reconstructed",
    );
  });

  it("refuses when a sidechain line falls within the chain's line range", () => {
    const lines = fixtureRaw.split("\n");
    lines.splice(
      3,
      0,
      JSON.stringify({
        type: "user",
        uuid: "side-1",
        parentUuid: null,
        sessionId: "session-abc",
        isSidechain: true,
        timestamp: "2026-01-01T00:00:02.500Z",
        message: { role: "user", content: "sidechain probe" },
      }),
    );
    const raw = lines.join("\n");
    const plan = planFixture({ nodes: nodesOf(raw), rawLines: raw.split("\n") });
    expect(plan.mode).toBe("tip");
    expect(plan.refusedReason).toBe(
      "chain crosses a compaction/summary boundary; exact context cannot be reconstructed",
    );
  });

  it("refuses when a chain node's transcript line is missing from rawLines", () => {
    // Nodes come from the full fixture, but the raw transcript we hand the
    // planner is missing the tool_result line the chain passes through.
    const rawLines = fixtureRaw
      .split("\n")
      .filter((l) => !l.includes("44444444-4444-4444-4444-444444444444"));
    const plan = planFixture({ rawLines });
    expect(plan.mode).toBe("tip");
    expect(plan.refusedReason).toBe("transcript lines missing for chain");
    expect(plan.resumeCommand).toBe("claude --resume session-abc --fork-session");
  });

  it("refuses (cycle-guarded) when parentage contains a cycle", () => {
    const a = makeGraphNode({ id: "claude:aaa", parentId: "claude:bbb" });
    const b = makeGraphNode({ id: "claude:bbb", parentId: "claude:aaa" });
    const plan = planFixture({ nodes: [a, b], targetNodeId: "claude:aaa" });
    expect(plan.mode).toBe("tip");
    expect(plan.refusedReason).toContain("cycle");
    expect(plan.resumeCommand).toBe("claude --resume session-abc --fork-session");
  });

  it("refuses when the target node is not in the node set", () => {
    const plan = planFixture({ targetNodeId: "claude:does-not-exist" });
    expect(plan.mode).toBe("tip");
    expect(plan.refusedReason).not.toBeNull();
    expect(plan.resumeCommand).toBe("claude --resume session-abc --fork-session");
  });
});

describe("executeRewind", () => {
  it("synthesizes a transcript that round-trips with matching kinds/order and fresh uuids", async () => {
    // Keep a byte-identical copy of the "original" on disk to prove we never
    // touch it.
    const originalPath = path.join(projectsSubdir, "original.jsonl");
    await writeFile(originalPath, fixtureRaw, "utf8");
    const originalBytesBefore = await readFile(originalPath);

    const plan = planFixture();
    const result = await executeRewind(plan, fixtureRaw.split("\n"));
    expect(result).toBe(plan);

    expect(plan.transcriptPath).not.toBeNull();
    const content = await readFile(plan.transcriptPath!, "utf8");
    const batch = parseSessionJsonl(plan.transcriptPath!, content);
    expect(batch).not.toBeNull();
    expect(batch!.session.id).toBe(plan.newSessionId);
    expect(batch!.nodes.map((n) => n.kind)).toEqual(plan.expectedKinds);

    const synthesized = jsonLinesOf(content);
    // 4 chain lines + the included sibling tool_result line (index 2).
    expect(synthesized).toHaveLength(5);

    // Every line's sessionId rewritten.
    for (const rec of synthesized) {
      expect(rec.sessionId).toBe(plan.newSessionId);
    }

    // All uuids fresh (no collision with any original uuid) and distinct.
    const originals = originalUuids(fixtureRaw);
    const newUuids = synthesized.map((r) => r.uuid as string);
    for (const u of newUuids) {
      expect(u).toMatch(UUID_RE);
      expect(originals.has(u)).toBe(false);
    }
    expect(new Set(newUuids).size).toBe(newUuids.length);

    // parentUuid remapping: first line null, later lines point at synthesized
    // uuids only (never at originals).
    expect(synthesized[0].parentUuid).toBeNull();
    const newUuidSet = new Set(newUuids);
    for (const rec of synthesized.slice(1)) {
      expect(typeof rec.parentUuid).toBe("string");
      expect(newUuidSet.has(rec.parentUuid as string)).toBe(true);
    }

    // Original file untouched, byte for byte.
    const originalBytesAfter = await readFile(originalPath);
    expect(originalBytesAfter.equals(originalBytesBefore)).toBe(true);
  });

  // V2 must-fix I3: the daemon's own watcher ingests every new .jsonl in
  // the projects dir — including the transcript executeRewind just wrote.
  // The sidecar is the provenance channel that lets ingest parent the
  // synthesized session to its origin node and skip T1 flag runs on the
  // synthesized (historical) lines. Transcript line CONTENT is never
  // mutated to carry this — a resume must load exactly native shape.
  it("writes a provenance sidecar next to the synthesized transcript: origin session + node, and the synthesized line uuids", async () => {
    const plan = planFixture();
    await executeRewind(plan, fixtureRaw.split("\n"));

    const sidecarPath = path.join(projectsSubdir, `${plan.newSessionId}.sojourn-rewind.json`);
    expect(existsSync(sidecarPath)).toBe(true);

    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as {
      originSessionId: string;
      originNodeId: string;
      lineUuids: string[];
    };
    expect(sidecar.originSessionId).toBe("session-abc");
    expect(sidecar.originNodeId).toBe(TIP_TARGET);

    // The sidecar pins the SYNTHESIZED transcript's line uuids, in order.
    const synthesized = jsonLinesOf(await readFile(plan.transcriptPath!, "utf8"));
    expect(sidecar.lineUuids).toEqual(synthesized.map((r) => r.uuid));

    // The synthesized transcript itself carries no sojourn markers: line
    // content must stay native-shaped for `claude --resume`.
    for (const rec of synthesized) {
      expect("sojournRewindOf" in rec).toBe(false);
    }
  });

  it("writes NO sidecar for a tip-mode plan (execute is a no-op)", async () => {
    const nodes = nodesOf(fixtureRaw).filter(
      (n) => n.id !== "claude:44444444-4444-4444-4444-444444444444",
    );
    const plan = planFixture({ nodes });
    expect(plan.mode).toBe("tip");

    await executeRewind(plan, fixtureRaw.split("\n"));
    const sidecars = readdirSync(projectsSubdir).filter((f) =>
      f.endsWith(".sojourn-rewind.json"),
    );
    expect(sidecars).toEqual([]);
  });

  it("truncates exactly at the target's line, dropping all post-target turns", async () => {
    const plan = planFixture({ targetNodeId: MID_LINE_TARGET });
    expect(plan.mode).toBe("exact");
    expect(plan.lineIndexes).toEqual([0, 1]);
    await executeRewind(plan, fixtureRaw.split("\n"));

    const content = await readFile(plan.transcriptPath!, "utf8");
    const synthesized = jsonLinesOf(content);
    expect(synthesized).toHaveLength(2);
    // Nothing from after the target's line leaks in.
    expect(content).not.toContain("tool_result");
    expect(content).not.toContain("Both files look straightforward");

    // Line granularity, documented behavior: the target is a mid-line
    // tool_use block, so its WHOLE line is kept — including the sibling
    // tool_use block that comes after it in the same line.
    const batch = parseSessionJsonl(plan.transcriptPath!, content)!;
    expect(batch.nodes.map((n) => n.kind)).toEqual([
      "prompt",
      "assistant",
      "tool_use",
      "tool_use",
    ]);
    expect(content).toContain("toolu_read_002");
  });

  it("splices parentUuid across a skipped system line to the previous included line", async () => {
    // Real transcripts interleave `type:"system"` lines that carry uuid +
    // parentUuid and thread the line chain, but produce no graph node (the
    // parser skips them). The chain therefore never includes them, so the
    // NEXT line's parentUuid dangles in the synthesized file and must be
    // re-pointed at the nearest preceding included line.
    const mk = (o: Record<string, unknown>) => JSON.stringify(o);
    const raw =
      [
        mk({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "sess-x",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "do things" },
        }),
        mk({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "sess-x",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "running a tool" },
              { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
            ],
          },
        }),
        mk({
          type: "system",
          uuid: "s1",
          parentUuid: "a1",
          sessionId: "sess-x",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:01.500Z",
          content: "hook ran",
        }),
        mk({
          type: "user",
          uuid: "r1",
          parentUuid: "s1",
          sessionId: "sess-x",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "aaa" }] },
        }),
        mk({
          type: "assistant",
          uuid: "a2",
          parentUuid: "r1",
          sessionId: "sess-x",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        }),
      ].join("\n") + "\n";

    const plan = planRewind({
      nodes: nodesOf(raw),
      targetNodeId: "claude:a2",
      rawLines: raw.split("\n"),
      projectsSubdir,
      sessionId: "sess-x",
    });
    expect(plan.mode).toBe("exact");
    // s1's line (index 2) hosts no node and no tool_result: excluded.
    expect(plan.lineIndexes).toEqual([0, 1, 3, 4]);

    await executeRewind(plan, raw.split("\n"));
    const synthesized = jsonLinesOf(await readFile(plan.transcriptPath!, "utf8"));
    expect(synthesized).toHaveLength(4);
    // r1's original parentUuid ("s1") was excluded: spliced to a1's new uuid.
    expect(synthesized[2].parentUuid).toBe(synthesized[1].uuid);
    // a2 still points at r1 (both included, normal remap).
    expect(synthesized[3].parentUuid).toBe(synthesized[2].uuid);
  });

  it("throws plan_invalid and writes nothing when rawLines drift between plan and execute", async () => {
    const plan = planFixture();
    // Simulate the transcript changing on disk after planning: line 0 now
    // carries a different uuid than the one the plan pinned.
    const lines = fixtureRaw.split("\n");
    expect(lines[0]).toContain("11111111-1111-1111-1111-111111111111");
    lines[0] = lines[0].replace(
      "11111111-1111-1111-1111-111111111111",
      "99999999-9999-9999-9999-999999999999",
    );
    await expect(executeRewind(plan, lines)).rejects.toMatchObject({
      name: "SojournRewindError",
      code: "plan_invalid",
    });
    // Nothing written — not even a tmp file.
    expect(readdirSync(projectsSubdir)).toEqual([]);
  });

  it("catches parentage-corrupting drift via parent-shape validation and deletes the file", async () => {
    const plan = planFixture();
    // Sabotage the remap input: uuids untouched (so per-line uuid pins still
    // match) but line 4's parentUuid re-pointed at the root — same kinds,
    // same count, same sessionId, DIFFERENT tree shape.
    const lines = fixtureRaw.split("\n");
    expect(lines[4]).toContain('"parentUuid":"44444444-4444-4444-4444-444444444444"');
    lines[4] = lines[4].replace(
      '"parentUuid":"44444444-4444-4444-4444-444444444444"',
      '"parentUuid":"11111111-1111-1111-1111-111111111111"',
    );
    await expect(executeRewind(plan, lines)).rejects.toMatchObject({
      name: "SojournRewindError",
      code: "validation_mismatch",
    });
    expect(existsSync(plan.transcriptPath!)).toBe(false);
    expect(readdirSync(projectsSubdir)).toEqual([]);
  });

  it("preserves uuids/sessionIds quoted inside message content verbatim (rewrite is field-level)", async () => {
    const mk = (o: Record<string, unknown>) => JSON.stringify(o);
    const raw =
      [
        mk({
          type: "user",
          uuid: "qu-1",
          parentUuid: null,
          sessionId: "sess-q",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "replay node qu-1 from session sess-q please" },
        }),
        mk({
          type: "assistant",
          uuid: "qa-1",
          parentUuid: "qu-1",
          sessionId: "sess-q",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "as recorded in qu-1 (session sess-q): done" }],
          },
        }),
      ].join("\n") + "\n";
    const plan = planRewind({
      nodes: nodesOf(raw),
      targetNodeId: "claude:qa-1",
      rawLines: raw.split("\n"),
      projectsSubdir,
      sessionId: "sess-q",
    });
    expect(plan.mode).toBe("exact");
    await executeRewind(plan, raw.split("\n"));
    const synthesized = jsonLinesOf(await readFile(plan.transcriptPath!, "utf8"));

    // Top-level identity FIELDS are rewritten...
    expect(synthesized[0].uuid).not.toBe("qu-1");
    expect(synthesized[1].uuid).not.toBe("qa-1");
    for (const rec of synthesized) expect(rec.sessionId).toBe(plan.newSessionId);
    expect(synthesized[1].parentUuid).toBe(synthesized[0].uuid);

    // ...but the same ids quoted INSIDE message content survive verbatim:
    // the rewrite is field-level, never a whole-line string replace.
    expect((synthesized[0].message as { content: string }).content).toBe(
      "replay node qu-1 from session sess-q please",
    );
    const assistantPayload = JSON.stringify(synthesized[1].message);
    expect(assistantPayload).toContain("qu-1");
    expect(assistantPayload).toContain("sess-q");
  });

  it("is a no-op for a tip (refused) plan", async () => {
    const nodes = nodesOf(fixtureRaw).filter(
      (n) => n.id !== "claude:44444444-4444-4444-4444-444444444444",
    );
    const plan = planFixture({ nodes });
    expect(plan.mode).toBe("tip");
    const result = await executeRewind(plan, fixtureRaw.split("\n"));
    expect(result).toBe(plan);
    expect(readdirSync(projectsSubdir)).toEqual([]);
  });

  it("deletes the synthesized file and throws SojournRewindError when round-trip validation fails", async () => {
    const plan = planFixture();
    // Tamper the expected chain projection so validation must fail.
    plan.expectedKinds = [...plan.expectedKinds, "prompt"];
    await expect(executeRewind(plan, fixtureRaw.split("\n"))).rejects.toBeInstanceOf(
      SojournRewindError,
    );
    expect(existsSync(plan.transcriptPath!)).toBe(false);
    // Atomic: no partial/tmp files left behind either.
    expect(readdirSync(projectsSubdir)).toEqual([]);
  });

  it("refuses to overwrite an existing transcript file (NEW files only)", async () => {
    const plan = planFixture();
    await writeFile(plan.transcriptPath!, "pre-existing\n", "utf8");
    await expect(executeRewind(plan, fixtureRaw.split("\n"))).rejects.toBeInstanceOf(
      SojournRewindError,
    );
    expect(await readFile(plan.transcriptPath!, "utf8")).toBe("pre-existing\n");
  });
});
