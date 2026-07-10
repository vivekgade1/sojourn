import { describe, expect, it } from "vitest";
import { layoutGraph, trailOf } from "../src/layout";
import type { ChronoNode } from "../src/types";

function makeNode(id: string, parentId: string | null, overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id,
    parentId,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: "2026-01-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: `node ${id}`,
    content: null,
    meta: { nativeUuid: id },
    ...overrides,
  };
}

describe("layoutGraph (left→right d3 tidy tree)", () => {
  it("places a parent strictly left of its child", () => {
    const nodes: ChronoNode[] = [makeNode("claude:1", null), makeNode("claude:2", "claude:1")];

    const { positions } = layoutGraph(nodes);

    const parentPos = positions.get("claude:1")!;
    const childPos = positions.get("claude:2")!;
    expect(parentPos).toBeDefined();
    expect(childPos).toBeDefined();
    expect(parentPos.x).toBeLessThan(childPos.x);
  });

  it("stacks siblings vertically in the same column (parallel tool calls)", () => {
    const nodes: ChronoNode[] = [
      makeNode("claude:p", null),
      makeNode("claude:a", "claude:p", { kind: "tool_use" }),
      makeNode("claude:b", "claude:p", { kind: "tool_use" }),
    ];

    const { positions } = layoutGraph(nodes);

    const a = positions.get("claude:a")!;
    const b = positions.get("claude:b")!;
    expect(a.x).toBe(b.x); // same depth column
    expect(a.y).not.toBe(b.y); // stacked, both present
  });

  it("produces an edge per known parent link and skips unknown parents", () => {
    const nodes: ChronoNode[] = [
      makeNode("claude:1", null),
      makeNode("claude:2", "claude:1"),
      makeNode("claude:3", "claude:ghost"),
    ];

    const { edges, positions } = layoutGraph(nodes);

    expect(edges).toEqual([{ id: "claude:1->claude:2", source: "claude:1", target: "claude:2" }]);
    // Unknown-parent node is treated as a root and still positioned.
    expect(positions.has("claude:3")).toBe(true);
  });

  it("stacks separate session trees newest-first and reports bounds", () => {
    const nodes: ChronoNode[] = [
      makeNode("claude:r1", null, { sessionId: "s1" }),
      makeNode("claude:c1", "claude:r1", { sessionId: "s1" }),
      makeNode("claude:r2", null, { sessionId: "s2", timestamp: "2026-01-02T00:00:00.000Z" }),
    ];

    const { positions, width, height } = layoutGraph(nodes);

    const r1 = positions.get("claude:r1")!;
    const r2 = positions.get("claude:r2")!;
    // r2 is NEWER, so its tree renders first (above the older r1 tree).
    expect(r2.y).toBeLessThan(r1.y);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it("is deterministic regardless of input order", () => {
    const nodes: ChronoNode[] = [
      makeNode("claude:p", null),
      makeNode("claude:a", "claude:p"),
      makeNode("claude:b", "claude:p"),
    ];

    const first = layoutGraph(nodes);
    const second = layoutGraph([...nodes].reverse());

    for (const [id, pos] of first.positions) {
      expect(second.positions.get(id)).toEqual(pos);
    }
  });

  it("returns an empty layout for an empty node list", () => {
    const { positions, edges, width, height } = layoutGraph([]);
    expect(positions.size).toBe(0);
    expect(edges).toEqual([]);
    expect(width).toBe(0);
    expect(height).toBe(0);
  });
});

describe("trailOf", () => {
  it("returns the lineage from root to the node, inclusive", () => {
    const nodes: ChronoNode[] = [
      makeNode("claude:root", null),
      makeNode("claude:mid", "claude:root"),
      makeNode("claude:leaf", "claude:mid"),
      makeNode("claude:other", "claude:root"),
    ];

    expect(trailOf("claude:leaf", nodes)).toEqual(["claude:root", "claude:mid", "claude:leaf"]);
  });

  it("terminates on cycles and unknown parents", () => {
    const a = makeNode("claude:a", "claude:b");
    const b = makeNode("claude:b", "claude:a");
    expect(trailOf("claude:a", [a, b])).toEqual(["claude:b", "claude:a"]);
    expect(trailOf("claude:x", [makeNode("claude:x", "claude:missing")])).toEqual(["claude:x"]);
    expect(trailOf(null, [a])).toEqual([]);
  });
});
