import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
// Importing the harness applies its SVGSVGElement width/height shim, which
// d3-zoom reads when the map mounts (jsdom doesn't implement it).
import "./harness";
import { JourneyMap } from "../src/components/JourneyMap";
import { buildJourneys } from "../src/turns";
import type { ChronoNode } from "../src/types";

afterEach(() => cleanup());

let ts = 0;
function makeNode(
  id: string,
  kind: ChronoNode["kind"],
  overrides: Partial<ChronoNode> = {},
): ChronoNode {
  ts += 1;
  return {
    id,
    parentId: null,
    kind,
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: `2026-01-01T00:00:${String(ts).padStart(2, "0")}.000Z`,
    snapshotRef: null,
    label: null,
    summary: `${kind} ${id}`,
    content: null,
    flags: [],
    annotations: [],
    meta: { nativeUuid: id },
    ...overrides,
  };
}

function renderMap(nodes: ChronoNode[]) {
  const journeys = buildJourneys(nodes);
  return render(
    <JourneyMap
      journeys={journeys}
      selectedTurnId={null}
      onSelectTurn={() => {}}
      onSelectNode={() => {}}
      selectedNodeId={null}
      matchedTurnIds={null}
      lenses={{ decision: false, flagged: false, restorable: false }}
      focusTurnId={null}
      focusNonce={0}
    />,
  );
}

describe("JourneyMap / restore markers", () => {
  it("renders a thinned/unavailable waypoint marker for a turn with a thinned node", () => {
    const { container } = renderMap([
      makeNode("p1", "prompt"),
      makeNode("a1", "assistant", { snapshotRef: "tree-gone", restorable: false }),
    ]);
    expect(container.querySelector('[data-testid="map-thinned"]')).toBeTruthy();
    // The thinned marker is distinct from the restore-ready dot.
    expect(container.querySelector(".map-restore-dot")).toBeNull();
  });

  it("renders the restore-ready dot (not the thinned marker) for an all-restorable turn", () => {
    const { container } = renderMap([
      makeNode("p2", "prompt"),
      makeNode("a2", "assistant", { snapshotRef: "tree-abc", restorable: true }),
    ]);
    expect(container.querySelector(".map-restore-dot")).toBeTruthy();
    expect(container.querySelector('[data-testid="map-thinned"]')).toBeNull();
  });

  it("shows neither marker for a turn with only unsnapshotted nodes", () => {
    const { container } = renderMap([
      makeNode("p3", "prompt"),
      makeNode("a3", "assistant", { snapshotRef: null, restorable: true }),
    ]);
    expect(container.querySelector(".map-restore-dot")).toBeNull();
    expect(container.querySelector('[data-testid="map-thinned"]')).toBeNull();
  });

  it("can render both markers when a turn has a restorable AND a thinned node", () => {
    const { container } = renderMap([
      makeNode("p4", "prompt"),
      makeNode("a4", "assistant", { snapshotRef: "tree-abc", restorable: true }),
      makeNode("t4", "tool_use", { snapshotRef: "tree-gone", restorable: false }),
    ]);
    expect(container.querySelector(".map-restore-dot")).toBeTruthy();
    expect(container.querySelector('[data-testid="map-thinned"]')).toBeTruthy();
  });
});
