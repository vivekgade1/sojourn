import { describe, expect, it } from "vitest";
import { buildJourneys, nodeToTurnIndex } from "../src/turns";
import type { ChronoNode, StoredFlag } from "../src/types";

let ts = 0;
function makeNode(
  id: string,
  kind: ChronoNode["kind"],
  overrides: Partial<ChronoNode> = {},
): ChronoNode {
  ts += 1;
  return {
    id,
    parentId: null, // deliberately: grouping must not depend on parentage
    kind,
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: `2026-01-01T00:00:${String(ts).padStart(2, "0")}.000Z`,
    snapshotRef: null,
    label: null,
    summary: `${kind} ${id}`,
    content: null,
    meta: { nativeUuid: id },
    ...overrides,
  };
}

function flag(tier: "verified" | "advisory", overrides: Partial<StoredFlag> = {}): StoredFlag {
  return {
    id: 1,
    nodeId: "x",
    kind: "edit_claim_mismatch",
    tier,
    confidence: "high",
    evidence: "e",
    source: "deterministic",
    dismissed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildJourneys", () => {
  it("splits a session into turns at each prompt, ignoring parentage entirely", () => {
    const nodes = [
      makeNode("p1", "prompt"),
      makeNode("a1", "assistant"),
      makeNode("t1", "tool_use", { content: { name: "Bash" } }),
      makeNode("r1", "tool_result"),
      makeNode("p2", "prompt"),
      makeNode("a2", "assistant"),
    ];

    const [journey] = buildJourneys(nodes);
    expect(journey!.turns).toHaveLength(2);
    expect(journey!.turns[0]!.nodes.map((n) => n.id)).toEqual(["p1", "a1", "t1", "r1"]);
    expect(journey!.turns[1]!.nodes.map((n) => n.id)).toEqual(["p2", "a2"]);
    expect(journey!.turns[0]!.toolCount).toBe(1);
    expect(journey!.turns[0]!.toolNames).toEqual(["Bash"]);
    expect(journey!.turns[0]!.ask).toBe("prompt p1");
    expect(journey!.turns[0]!.gist).toBe("assistant a1");
  });

  it("collects pre-prompt nodes into a preamble turn", () => {
    const nodes = [makeNode("sys", "assistant"), makeNode("p1", "prompt"), makeNode("a1", "assistant")];
    const [journey] = buildJourneys(nodes);
    expect(journey!.turns).toHaveLength(2);
    expect(journey!.turns[0]!.promptNode).toBeNull();
    expect(journey!.turns[0]!.ask).toBe("(session preamble)");
  });

  it("counts only ACTIVE flags (not dismissed, not auto-resolved) per tier", () => {
    const nodes = [
      makeNode("p1", "prompt"),
      makeNode("a1", "assistant", {
        flags: [
          flag("verified", { id: 1 }),
          flag("verified", { id: 2, dismissed: true }),
          flag("verified", { id: 3, autoResolved: true }),
          flag("advisory", { id: 4 }),
        ],
      }),
    ];
    const [journey] = buildJourneys(nodes);
    expect(journey!.turns[0]!.verifiedCount).toBe(1);
    expect(journey!.turns[0]!.advisoryCount).toBe(1);
  });

  it("marks the turn containing the session's latest node as 'here' and collects marks", () => {
    const nodes = [
      makeNode("p1", "prompt"),
      makeNode("d1", "decision"),
      makeNode("p2", "prompt"),
      makeNode("a2", "assistant"),
    ];
    const [journey] = buildJourneys(nodes);
    expect(journey!.turns[0]!.marks.map((n) => n.id)).toEqual(["d1"]);
    expect(journey!.turns[0]!.isHere).toBe(false);
    expect(journey!.turns[1]!.isHere).toBe(true);
  });

  it("separates sessions into journeys, newest first", () => {
    const nodes = [
      makeNode("p1", "prompt", { sessionId: "old" }),
      makeNode("p2", "prompt", { sessionId: "new" }),
    ];
    const journeys = buildJourneys(nodes);
    expect(journeys.map((j) => j.sessionId)).toEqual(["new", "old"]);
  });

  it("nodeToTurnIndex maps every node to its containing turn", () => {
    const nodes = [makeNode("p1", "prompt"), makeNode("a1", "assistant"), makeNode("p2", "prompt")];
    const journeys = buildJourneys(nodes);
    const index = nodeToTurnIndex(journeys);
    expect(index.get("a1")).toBe("p1");
    expect(index.get("p2")).toBe("p2");
  });

  it("marks a turn restore-ready when it holds >=1 snapshot-bearing restorable node", () => {
    const nodes = [
      makeNode("p1", "prompt"),
      makeNode("a1", "assistant", { snapshotRef: "tree-abc", restorable: true }),
    ];
    const [journey] = buildJourneys(nodes);
    expect(journey!.turns[0]!.hasRestorable).toBe(true);
    expect(journey!.turns[0]!.restorableCount).toBe(1);
  });

  it("treats a snapshot-bearing node with a MISSING restorable field as restore-ready (backward-safe)", () => {
    const nodes = [
      makeNode("p1", "prompt"),
      // snapshotRef present, restorable undefined → unknown-safe → counts.
      makeNode("a1", "assistant", { snapshotRef: "tree-def" }),
    ];
    const [journey] = buildJourneys(nodes);
    expect(journey!.turns[0]!.hasRestorable).toBe(true);
    expect(journey!.turns[0]!.restorableCount).toBe(1);
  });

  it("is NOT restore-ready when every node is thinned or unsnapshotted", () => {
    const nodes = [
      makeNode("p1", "prompt"), // no snapshot
      // thinned: snapshot recorded but no longer restorable (gc'd)
      makeNode("a1", "assistant", { snapshotRef: "tree-gone", restorable: false }),
      // unsnapshotted but nominally restorable via an ancestor — not a restore anchor itself
      makeNode("t1", "tool_use", { snapshotRef: null, restorable: true }),
    ];
    const [journey] = buildJourneys(nodes);
    expect(journey!.turns[0]!.hasRestorable).toBe(false);
    expect(journey!.turns[0]!.restorableCount).toBe(0);
  });
});
