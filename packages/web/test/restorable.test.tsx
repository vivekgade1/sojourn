import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SojournNode } from "../src/components/SojournNode";
import { Legend } from "../src/components/Legend";
import type { ChronoNode } from "../src/types";

afterEach(() => cleanup());

function makeNode(id: string, overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id,
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: "2026-01-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: `node ${id}`,
    content: null,
    flags: [],
    annotations: [],
    meta: { nativeUuid: id },
    ...overrides,
  };
}

describe("SojournNode / restore-ready + thinned treatments", () => {
  it("marks a snapshot-bearing restorable node as restore-ready", () => {
    const node = makeNode("n1", { snapshotRef: "tree-abc", restorable: true });
    const { container } = render(<SojournNode node={node} />);
    expect(container.querySelector(".sojourn-node.restore-ready")).toBeTruthy();
    expect(container.querySelector(".sojourn-node.thinned")).toBeNull();
  });

  it("treats a snapshot-bearing node with a MISSING restorable field as restore-ready (backward-safe)", () => {
    const node = makeNode("n2", { snapshotRef: "tree-def" });
    const { container } = render(<SojournNode node={node} />);
    expect(container.querySelector(".sojourn-node.restore-ready")).toBeTruthy();
    expect(container.querySelector(".sojourn-node.thinned")).toBeNull();
  });

  it("marks a snapshot-bearing node that is no longer restorable as thinned", () => {
    const node = makeNode("n3", { snapshotRef: "tree-gone", restorable: false });
    const { container } = render(<SojournNode node={node} />);
    expect(container.querySelector(".sojourn-node.thinned")).toBeTruthy();
    expect(container.querySelector(".sojourn-node.restore-ready")).toBeNull();
  });

  it("gives a node with no snapshot neither treatment", () => {
    const node = makeNode("n4", { snapshotRef: null, restorable: true });
    const { container } = render(<SojournNode node={node} />);
    expect(container.querySelector(".sojourn-node.restore-ready")).toBeNull();
    expect(container.querySelector(".sojourn-node.thinned")).toBeNull();
  });

  it("composes restore-ready with existing emphasis (search-hit) without dropping either", () => {
    const node = makeNode("n5", { snapshotRef: "tree-abc", restorable: true });
    const { container } = render(<SojournNode node={node} searchHit />);
    const el = container.querySelector(".sojourn-node")!;
    expect(el.className).toMatch(/restore-ready/);
    expect(el.className).toMatch(/search-hit/);
  });
});

describe("Legend / restore-point chip", () => {
  it("renders a restore-point chip with its glyph in the map view", () => {
    const { container, getByText } = render(
      <Legend nodeCount={3} sessionCount={1} totalSessionCount={1} view="map" restorableOnly={false} />,
    );
    expect(getByText(/restore point/i)).toBeTruthy();
    expect(container.querySelector(".legend-glyph-restore")).toBeTruthy();
  });

  it("renders a restore-point chip in the graph view", () => {
    const { container, getByText } = render(
      <Legend nodeCount={3} sessionCount={1} totalSessionCount={1} view="graph" restorableOnly={false} />,
    );
    expect(getByText(/restore point/i)).toBeTruthy();
    expect(container.querySelector(".legend-glyph-restore")).toBeTruthy();
  });
});
