import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseSessionJsonl, planRewind } from "../src/index.js";
import type { ChronoNode } from "@sojourn/core";

/**
 * In-process vitest counterpart to scripts/e2e/conformance.mjs — same golden
 * fixtures, same invariants, but run directly against SOURCE (via the
 * workspace's vite-node alias) rather than a built dist, so it runs as part
 * of the normal `npm test` loop without a `build:node` prerequisite.
 *
 * Deliberately narrower than the .mjs script: Claude-only (this package
 * doesn't depend on adapter-opencode), and every expectation below is
 * reimplemented from scratch against the raw fixture text — never derived
 * from the parser's own output — so drift between the parser and the
 * fixture's actual shape is a real regression signal, not a tautology.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "..", "..", "..", "scripts", "e2e", "fixtures");

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

function byNativeUuid(nodes: ChronoNode[]): Map<string, ChronoNode> {
  const map = new Map<string, ChronoNode>();
  for (const n of nodes) if (n.meta?.nativeUuid) map.set(n.meta.nativeUuid, n);
  return map;
}

// ---------------------------------------------------------------------------
// Independent expectation scan — a SECOND, from-scratch read of the raw
// JSONL text, mirroring scripts/e2e/conformance.mjs's scanClaudeRaw/
// chronoTurnCounts but reimplemented here rather than imported, per the
// "computed independently in the test" requirement.
// ---------------------------------------------------------------------------
function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface RawScan {
  promptLines: number;
  expectedNodes: number;
  multiToolLines: { toolIds: string[] }[];
}

function scanClaudeRaw(raw: string): RawScan {
  let promptLines = 0;
  let expectedNodes = 0;
  const multiToolLines: { toolIds: string[] }[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let rec: unknown;
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
      const blocks: Record<string, unknown>[] = Array.isArray(content)
        ? content.filter(isRec)
        : typeof content === "string"
          ? [{ type: "text", text: content }]
          : [];
      const toolIds: string[] = [];
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

/** Chronological turn grouping — MINIMAL reimplementation of the rule in
 * packages/web/src/turns.ts: group by session, sort chronologically
 * (timestamp then id), and open a new turn at every "prompt" node once the
 * current group is non-empty. */
function totalTurns(nodes: ChronoNode[]): number {
  const bySession = new Map<string, ChronoNode[]>();
  for (const n of nodes) {
    const list = bySession.get(n.sessionId) ?? [];
    list.push(n);
    bySession.set(n.sessionId, list);
  }
  let turns = 0;
  for (const list of bySession.values()) {
    const ordered = [...list].sort((a, b) =>
      a.timestamp === b.timestamp ? (a.id < b.id ? -1 : 1) : a.timestamp < b.timestamp ? -1 : 1,
    );
    let currentLen = 0;
    for (const node of ordered) {
      if (node.kind === "prompt" && currentLen > 0) {
        turns++;
        currentLen = 0;
      }
      currentLen++;
    }
    if (currentLen > 0) turns++;
  }
  return turns;
}

/** Every group of parallel tool_use ids must resolve to exactly one shared parentId. */
function assertFanOut(groups: { toolIds: string[] }[], nodesByUuid: Map<string, ChronoNode>) {
  expect(groups.length).toBeGreaterThan(0);
  for (const { toolIds } of groups) {
    const parents = new Set<string | null>();
    for (const id of toolIds) {
      const node = nodesByUuid.get(id);
      expect(node, `node missing for tool_use id ${id}`).toBeDefined();
      parents.add(node!.parentId);
    }
    expect(parents.size, `tool_use ids [${toolIds.join(",")}] must share one parent`).toBe(1);
  }
}

const claudeFixtures = ["orphaned-parentage.jsonl", "compaction-session.jsonl", "thousand-steps.jsonl"];

describe("adapter-claude conformance (source, golden fixtures)", () => {
  for (const fixtureName of claudeFixtures) {
    describe(fixtureName, () => {
      const raw = readFixture(fixtureName);

      it("parseSessionJsonl never throws and yields node count > 0", () => {
        let batch: ReturnType<typeof parseSessionJsonl> = null;
        expect(() => {
          batch = parseSessionJsonl(path.join(FIXTURES, fixtureName), raw);
        }).not.toThrow();
        expect(batch).not.toBeNull();
        expect(batch!.nodes.length).toBeGreaterThan(0);
      });

      it("parallel tool_use blocks fan out to siblings sharing exactly one parent", () => {
        const batch = parseSessionJsonl(path.join(FIXTURES, fixtureName), raw)!;
        const nodesByUuid = byNativeUuid(batch.nodes);
        const rawScan = scanClaudeRaw(raw);
        assertFanOut(rawScan.multiToolLines, nodesByUuid);
      });

      it("chronological turn count matches an independently computed expectation", () => {
        const batch = parseSessionJsonl(path.join(FIXTURES, fixtureName), raw)!;
        const rawScan = scanClaudeRaw(raw);
        expect(totalTurns(batch.nodes)).toBe(rawScan.promptLines);
      });

      it("node count matches an independently computed expectation", () => {
        const batch = parseSessionJsonl(path.join(FIXTURES, fixtureName), raw)!;
        const rawScan = scanClaudeRaw(raw);
        expect(batch.nodes.length).toBe(rawScan.expectedNodes);
      });
    });
  }

  describe("orphaned-parentage.jsonl", () => {
    const raw = readFixture("orphaned-parentage.jsonl");

    it("still yields nodes despite broken parentUuid references (resolves to parentId=null, no crash)", () => {
      const batch = parseSessionJsonl(path.join(FIXTURES, "orphaned-parentage.jsonl"), raw)!;
      expect(batch.nodes.length).toBeGreaterThan(0);
      const nodesByUuid = byNativeUuid(batch.nodes);
      const u1 = nodesByUuid.get("orph-u1"); // parentUuid points at a nonexistent ghost id
      const a2 = nodesByUuid.get("orph-a2"); // parentUuid points at a different ghost id
      expect(u1).toBeDefined();
      expect(u1!.parentId).toBeNull();
      expect(a2).toBeDefined();
      expect(a2!.parentId).toBeNull();
    });

    it("still lands a node for a tool_result whose tool_use_id is unmatched", () => {
      const batch = parseSessionJsonl(path.join(FIXTURES, "orphaned-parentage.jsonl"), raw)!;
      const nodesByUuid = byNativeUuid(batch.nodes);
      const ghostResult = nodesByUuid.get("orph-tr-ghost");
      expect(ghostResult).toBeDefined();
      expect(ghostResult!.kind).toBe("tool_result");
      expect(ghostResult!.parentId).not.toBeUndefined();
    });
  });

  describe("compaction-session.jsonl: planRewind", () => {
    // rewind.ts is STABLE (its fix round is complete). This is the flagship
    // REFUSAL invariant — a target on the far side of a compaction boundary
    // must never be exact-rewound — so it is asserted DIRECTLY: planRewind
    // is imported at module scope (a hard import; a missing/renamed export
    // fails collection, not a silent skip), and any throw or unrecognized
    // return shape below is a FAILURE, not a reason to skip.
    it("refuses exact mode for a target on the far side of the compaction boundary", () => {
      const raw = readFixture("compaction-session.jsonl");
      const fixturePath = path.join(FIXTURES, "compaction-session.jsonl");
      const batch = parseSessionJsonl(fixturePath, raw);
      expect(batch).not.toBeNull();
      expect(batch!.nodes.length).toBeGreaterThan(0);
      const targetNodeId = batch!.nodes[batch!.nodes.length - 1]!.id; // far side of the compaction boundary

      const plan = planRewind({
        nodes: batch!.nodes,
        targetNodeId,
        rawLines: raw.split("\n"),
        projectsSubdir: path.dirname(fixturePath),
        sessionId: batch!.session.id,
      });

      expect(plan.mode).toBe("tip");
      expect(typeof plan.refusedReason).toBe("string");
      expect(plan.refusedReason && plan.refusedReason.length).toBeGreaterThan(0);
    });
  });
});
