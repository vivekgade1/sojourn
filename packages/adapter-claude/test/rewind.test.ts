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
    // assistant text(4). Line 2 (tool_result for the OTHER tool_use) is not
    // on the ancestor chain.
    expect(plan.lineIndexes).toEqual([0, 1, 3, 4]);
    expect(plan.expectedKinds).toEqual([
      "prompt",
      "assistant",
      "tool_use",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
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
    expect(synthesized).toHaveLength(4);

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

  it("splices parentUuid to the previous included line when the original parent line is excluded", async () => {
    // Real transcripts chain parentUuid linearly line-by-line, so a chain
    // that skips a sibling tool_result line leaves the next line's
    // parentUuid dangling; it must be re-pointed at the nearest preceding
    // included line.
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
              { type: "text", text: "running two tools" },
              { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
              { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/b" } },
            ],
          },
        }),
        mk({
          type: "user",
          uuid: "r1",
          parentUuid: "a1",
          sessionId: "sess-x",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "aaa" }] },
        }),
        mk({
          type: "user",
          uuid: "r2",
          parentUuid: "r1",
          sessionId: "sess-x",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "bbb" }] },
        }),
        mk({
          type: "assistant",
          uuid: "a2",
          parentUuid: "r2",
          sessionId: "sess-x",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:04.000Z",
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
    // r1's line (index 2) is not on the chain.
    expect(plan.lineIndexes).toEqual([0, 1, 3, 4]);

    await executeRewind(plan, raw.split("\n"));
    const synthesized = jsonLinesOf(await readFile(plan.transcriptPath!, "utf8"));
    expect(synthesized).toHaveLength(4);
    // r2's original parentUuid ("r1") was excluded: spliced to a1's new uuid.
    expect(synthesized[2].parentUuid).toBe(synthesized[1].uuid);
    // a2 still points at r2 (both included, normal remap).
    expect(synthesized[3].parentUuid).toBe(synthesized[2].uuid);
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
