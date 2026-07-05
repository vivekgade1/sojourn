import { describe, expect, it } from "vitest";
import { layoutGraph } from "../src/layout";
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

describe("layoutGraph", () => {
  it("places a parent above its child (top-down)", () => {
    const nodes: ChronoNode[] = [makeNode("claude:1", null), makeNode("claude:2", "claude:1")];

    const { positions } = layoutGraph(nodes);

    const parentPos = positions.get("claude:1")!;
    const childPos = positions.get("claude:2")!;

    expect(parentPos).toBeDefined();
    expect(childPos).toBeDefined();
    // top-down: smaller y is "above" — parent must be strictly above child
    expect(parentPos.y).toBeLessThan(childPos.y);
  });

  it("places siblings side by side (same rank, different x)", () => {
    const nodes: ChronoNode[] = [
      makeNode("claude:1", null),
      makeNode("claude:2", "claude:1"),
      makeNode("claude:3", "claude:1"),
    ];

    const { positions } = layoutGraph(nodes);

    const childA = positions.get("claude:2")!;
    const childB = positions.get("claude:3")!;

    expect(childA.y).toBeCloseTo(childB.y, 5);
    expect(childA.x).not.toBeCloseTo(childB.x, 5);
  });

  it("produces edges from parentId relationships", () => {
    const nodes: ChronoNode[] = [makeNode("claude:1", null), makeNode("claude:2", "claude:1")];

    const { edges } = layoutGraph(nodes);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "claude:1", target: "claude:2" });
  });

  it("handles a node whose parentId is not present in the node set", () => {
    const nodes: ChronoNode[] = [makeNode("claude:2", "claude:missing")];

    const { positions, edges } = layoutGraph(nodes);

    expect(positions.get("claude:2")).toBeDefined();
    expect(edges).toHaveLength(0);
  });

  it("returns an empty layout for an empty node list", () => {
    const { positions, edges } = layoutGraph([]);
    expect(positions.size).toBe(0);
    expect(edges).toHaveLength(0);
  });
});
