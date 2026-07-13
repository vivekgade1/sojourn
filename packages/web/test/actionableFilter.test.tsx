// Tests for the "Restorable" (actionable) toolbar filter + its distinct action
// palette. Covers: the App-level graph filter (composes with flagged = AND, and
// with the session filter), the JourneyMap fade lens (AND-composition), the
// SojournNode .action-highlight class gating, the Legend chip, and a real
// getComputedStyle assertion that the action hue differs from every kind token
// and the restore-ready accent, in BOTH themes.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "../src/App";
import { api } from "../src/api";
import { layoutGraph } from "../src/layout";
import { JourneyMap } from "../src/components/JourneyMap";
import { SojournNode } from "../src/components/SojournNode";
import { Legend } from "../src/components/Legend";
import { buildJourneys } from "../src/turns";
import type { ChronoNode, StoredFlag } from "../src/types";
import { FakeWebSocket, graphResponse, makeNode, project } from "./harness";

// Mirror sessionFilter.test.tsx: wrap layoutGraph so we can assert on the
// ACTUAL layout input — proving the filter runs BEFORE layout, not via CSS.
vi.mock("../src/layout", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/layout")>();
  return { ...mod, layoutGraph: vi.fn(mod.layoutGraph) };
});
const layoutSpy = vi.mocked(layoutGraph);

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css");

function verifiedFlag(nodeId: string): StoredFlag {
  return {
    id: 1,
    nodeId,
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence: "high",
    evidence: "e",
    source: "deterministic",
    dismissed: false,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

// ——————————————————————————————————————————————————————————————————
// App-level: the graph filter isolates restorable===true nodes, composes
// with flagged (AND), and treats false/undefined as excluded.
// ——————————————————————————————————————————————————————————————————
describe("App / Restorable filter — graph node set", () => {
  // a,b restorable; b also flagged; c restorable:false; d restorable undefined.
  const nodes: ChronoNode[] = [
    makeNode("a", { kind: "prompt", restorable: true }),
    makeNode("b", { kind: "assistant", restorable: true, flags: [verifiedFlag("b")] }),
    makeNode("c", { kind: "assistant", restorable: false }),
    makeNode("d", { kind: "assistant" }), // restorable field MISSING
  ];

  function stubApi(list: ChronoNode[]) {
    vi.spyOn(api, "listProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getGraph").mockResolvedValue(graphResponse(list));
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "test" });
  }

  async function renderGraphApp(list: ChronoNode[]) {
    stubApi(list);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("legend")).toBeTruthy());
    await waitFor(() => expect(vi.mocked(api.getGraph)).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    await waitFor(() => expect(layoutSpy).toHaveBeenCalled());
  }

  function toggleRestorable() {
    fireEvent.click(screen.getByRole("checkbox", { name: /restorable/i }));
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    localStorage.clear();
    layoutSpy.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps only restorable===true nodes; false and undefined are excluded", async () => {
    await renderGraphApp(nodes);
    // All four laid out before the filter.
    await waitFor(() => expect(layoutSpy.mock.calls.at(-1)![0]).toHaveLength(4));

    toggleRestorable();

    await waitFor(() => {
      const laidOut = layoutSpy.mock.calls.at(-1)![0] as ChronoNode[];
      expect(laidOut.map((n) => n.id).sort()).toEqual(["a", "b"]);
      expect(laidOut.every((n) => n.restorable === true)).toBe(true);
    });
  });

  it("composes with 'Flagged only' as AND — a restorable-but-unflagged node drops out", async () => {
    await renderGraphApp(nodes);
    toggleRestorable();
    fireEvent.click(screen.getByRole("checkbox", { name: /flagged only/i }));

    await waitFor(() => {
      const laidOut = layoutSpy.mock.calls.at(-1)![0] as ChronoNode[];
      // Only b is BOTH restorable and flagged.
      expect(laidOut.map((n) => n.id)).toEqual(["b"]);
    });
  });

  it("every rendered graph card is action-highlighted while the filter is on, none when off", async () => {
    await renderGraphApp(nodes);
    // Off: no action treatment anywhere.
    expect(document.querySelectorAll(".sojourn-node.action-highlight")).toHaveLength(0);

    toggleRestorable();

    await waitFor(() => {
      const cards = document.querySelectorAll('[data-testid="sojourn-node"]');
      expect(cards.length).toBeGreaterThan(0);
      // Under the filter every visible card is restorable → every one highlighted.
      cards.forEach((c) => expect(c.className).toMatch(/action-highlight/));
    });
  });
});

// ——————————————————————————————————————————————————————————————————
// SojournNode: the .action-highlight class is purely prop-driven.
// ——————————————————————————————————————————————————————————————————
describe("SojournNode / action-highlight class", () => {
  afterEach(() => cleanup());

  it("adds action-highlight when the prop is set", () => {
    const node = makeNode("n1", { restorable: true });
    const { container } = render(<SojournNode node={node} actionHighlight />);
    expect(container.querySelector(".sojourn-node.action-highlight")).toBeTruthy();
  });

  it("omits action-highlight by default", () => {
    const node = makeNode("n2", { restorable: true });
    const { container } = render(<SojournNode node={node} />);
    expect(container.querySelector(".sojourn-node.action-highlight")).toBeNull();
  });

  it("composes with restore-ready without dropping either class", () => {
    const node = makeNode("n3", { snapshotRef: "tree-abc", restorable: true });
    const { container } = render(<SojournNode node={node} actionHighlight />);
    const el = container.querySelector(".sojourn-node")!;
    expect(el.className).toMatch(/action-highlight/);
    expect(el.className).toMatch(/restore-ready/);
  });
});

// ——————————————————————————————————————————————————————————————————
// JourneyMap: the restorable lens fades turns with no restore anchor, and
// AND-composes with the decision/flagged lenses.
// ——————————————————————————————————————————————————————————————————
describe("JourneyMap / restorable fade lens", () => {
  afterEach(() => cleanup());

  let ts = 0;
  function n(id: string, kind: ChronoNode["kind"], overrides: Partial<ChronoNode> = {}): ChronoNode {
    ts += 1;
    return makeNode(id, {
      kind,
      timestamp: `2026-01-01T00:00:${String(ts).padStart(2, "0")}.000Z`,
      ...overrides,
    });
  }

  type Lenses = { decision: boolean; flagged: boolean; restorable: boolean };
  function renderMap(nodes: ChronoNode[], lenses: Lenses) {
    return render(
      <JourneyMap
        journeys={buildJourneys(nodes)}
        selectedTurnId={null}
        onSelectTurn={() => {}}
        onSelectNode={() => {}}
        selectedNodeId={null}
        matchedTurnIds={null}
        lenses={lenses}
        focusTurnId={null}
        focusNonce={0}
      />,
    );
  }

  function fadedFlags(container: HTMLElement): boolean[] {
    return [...container.querySelectorAll('[data-testid="map-waypoint"]')].map((w) =>
      (w.getAttribute("class") ?? "").split(/\s+/).includes("faded"),
    );
  }

  it("fades a turn with NO restore anchor, keeps a turn that has one", () => {
    // Turn 1 has a restore anchor; turn 2 does not.
    const { container } = renderMap(
      [
        n("p1", "prompt"),
        n("a1", "assistant", { snapshotRef: "tree-abc", restorable: true }),
        n("p2", "prompt"),
        n("a2", "assistant"),
      ],
      { decision: false, flagged: false, restorable: true },
    );
    expect(fadedFlags(container)).toEqual([false, true]);
  });

  it("AND-composes decision + restorable: a turn must have BOTH a mark and an anchor", () => {
    // Turn 1: mark + anchor (kept). Turn 2: anchor but no mark (faded).
    const { container } = renderMap(
      [
        n("p1", "prompt"),
        n("d1", "decision", { snapshotRef: "tree-abc", restorable: true }),
        n("p2", "prompt"),
        n("a2", "assistant", { snapshotRef: "tree-def", restorable: true }),
      ],
      { decision: true, flagged: false, restorable: true },
    );
    expect(fadedFlags(container)).toEqual([false, true]);
  });

  it("no active lens fades nothing", () => {
    const { container } = renderMap(
      [n("p1", "prompt"), n("a1", "assistant"), n("p2", "prompt"), n("a2", "assistant")],
      { decision: false, flagged: false, restorable: false },
    );
    expect(fadedFlags(container)).toEqual([false, false]);
  });

  // Regression: the reviewer found the restorable LENS keyed off turn.hasRestorable
  // (isRestoreReady — missing restorable = INCLUDED, backward-safe) while the graph
  // filter keys off isActionable (restorable === true — missing = EXCLUDED). Same
  // toggle, contradictory result for a legacy payload (snapshot present, restorable
  // field absent). The map must now match the graph: strict everywhere.
  it("fades a turn whose only snapshotted node has restorable: undefined (legacy payload) — matching the graph filter excluding it — while a restorable:true turn stays actionable", () => {
    const { container } = renderMap(
      [
        n("p1", "prompt"),
        // Legacy payload: has a snapshot (would be hasRestorable/restore-ready)
        // but NO restorable field — isActionable/hasActionable must reject it.
        n("a1", "assistant", { snapshotRef: "tree-legacy" }),
        n("p2", "prompt"),
        n("a2", "assistant", { snapshotRef: "tree-abc", restorable: true }),
      ],
      { decision: false, flagged: false, restorable: true },
    );
    expect(fadedFlags(container)).toEqual([true, false]);
  });

  it("keys the amber action recolor off STRICT hasActionable, not hasRestorable", () => {
    const { container } = renderMap(
      [
        n("p1", "prompt"),
        n("a1", "assistant", { snapshotRef: "tree-legacy" }), // hasRestorable true, hasActionable false
        n("p2", "prompt"),
        n("a2", "assistant", { snapshotRef: "tree-abc", restorable: true }), // both true
      ],
      { decision: false, flagged: false, restorable: true },
    );
    const waypoints = [...container.querySelectorAll('[data-testid="map-waypoint"]')];
    const isAction = waypoints.map((w) => (w.getAttribute("class") ?? "").split(/\s+/).includes("action"));
    expect(isAction).toEqual([false, true]);
  });

  it("AND-composes flagged + restorable: a turn must have BOTH an active flag and an anchor", () => {
    // Turn 1: flag + anchor (kept). Turn 2: anchor but no flag (faded).
    const { container } = renderMap(
      [
        n("p1", "prompt"),
        n("a1", "assistant", {
          snapshotRef: "tree-abc",
          restorable: true,
          flags: [verifiedFlag("a1")],
        }),
        n("p2", "prompt"),
        n("a2", "assistant", { snapshotRef: "tree-def", restorable: true }),
      ],
      { decision: false, flagged: true, restorable: true },
    );
    expect(fadedFlags(container)).toEqual([false, true]);
  });

  it("AND-composes all three lenses: a turn must have a mark, an active flag, AND an anchor", () => {
    // Turn 1: mark + flag + anchor — satisfies all three (kept).
    // Turn 2: flag + anchor but NO mark — fails one lens (faded).
    // Turn 3: mark + anchor but NO flag — fails one lens (faded).
    const { container } = renderMap(
      [
        n("p1", "prompt"),
        n("d1", "decision", {
          snapshotRef: "tree-abc",
          restorable: true,
          flags: [verifiedFlag("d1")],
        }),
        n("p2", "prompt"),
        n("a2", "assistant", {
          snapshotRef: "tree-def",
          restorable: true,
          flags: [verifiedFlag("a2")],
        }),
        n("p3", "prompt"),
        n("d3", "decision", { snapshotRef: "tree-ghi", restorable: true }),
      ],
      { decision: true, flagged: true, restorable: true },
    );
    expect(fadedFlags(container)).toEqual([false, true, true]);
  });
});

// ——————————————————————————————————————————————————————————————————
// Restorable filter composed with the MULTI-session selection: a restorable
// node in a session that isn't currently selected must not surface anywhere
// (graph nodes or map turns), even though it satisfies the actionable check
// on its own. Reuses the App-level session-filter harness (makeNode +
// sessionId + timestamp, mirroring sessionFilter.test.tsx).
// ——————————————————————————————————————————————————————————————————
describe("App / Restorable filter composed with multi-session selection", () => {
  // Session A (older, NOT selected by default): one turn, actionable.
  const sessionA: ChronoNode[] = [
    makeNode("sA-p1", { kind: "prompt", sessionId: "sA", timestamp: "2026-07-01T10:00:00.000Z" }),
    makeNode("sA-a1", {
      kind: "assistant",
      sessionId: "sA",
      timestamp: "2026-07-01T10:01:00.000Z",
      snapshotRef: "tree-a",
      restorable: true,
    }),
  ];
  // Session B (newer, selected by default): two turns, NOT actionable. A
  // distinct turn count from session A's (one) so the filter-panel checkbox
  // labels ("N turn(s) · claude") disambiguate the two rows unambiguously.
  const sessionB: ChronoNode[] = [
    makeNode("sB-p1", { kind: "prompt", sessionId: "sB", timestamp: "2026-07-02T10:00:00.000Z" }),
    makeNode("sB-a1", { kind: "assistant", sessionId: "sB", timestamp: "2026-07-02T10:01:00.000Z" }),
    makeNode("sB-p2", { kind: "prompt", sessionId: "sB", timestamp: "2026-07-02T10:02:00.000Z" }),
    makeNode("sB-a2", { kind: "assistant", sessionId: "sB", timestamp: "2026-07-02T10:03:00.000Z" }),
  ];

  function stubApi(list: ChronoNode[]) {
    vi.spyOn(api, "listProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getGraph").mockResolvedValue(graphResponse(list));
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "test" });
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    localStorage.clear();
    layoutSpy.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("graph: a restorable:true node in a DESELECTED session does not appear until its session is selected", async () => {
    stubApi([...sessionA, ...sessionB]);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("legend")).toBeTruthy());
    await waitFor(() => expect(vi.mocked(api.getGraph)).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /restorable/i }));

    // Default session selection = newest only (sB), which has no actionable node.
    await waitFor(() => {
      expect(layoutSpy.mock.calls.at(-1)![0]).toEqual([]);
    });

    // Select session A too — its restorable node now appears.
    fireEvent.click(screen.getByTestId("session-filter-button"));
    fireEvent.click(screen.getByRole("checkbox", { name: /1 turn · claude/i }));
    await waitFor(() => {
      const laidOut = layoutSpy.mock.calls.at(-1)![0] as ChronoNode[];
      expect(laidOut.map((node) => node.id)).toEqual(["sA-a1"]);
    });
  });

  it("map: an actionable turn in a DESELECTED session isn't rendered until its session is selected", async () => {
    stubApi([...sessionA, ...sessionB]);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("legend")).toBeTruthy());
    await waitFor(() => expect(vi.mocked(api.getGraph)).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("checkbox", { name: /restorable/i }));

    function isFaded(el: Element): boolean {
      return (el.getAttribute("class") ?? "").split(/\s+/).includes("faded");
    }

    // Default = sB only (2 turns, neither actionable): both faded under the lens.
    await waitFor(() => {
      const waypoints = screen.queryAllByTestId("map-waypoint");
      expect(waypoints).toHaveLength(2);
      expect(waypoints.every(isFaded)).toBe(true);
    });

    fireEvent.click(screen.getByTestId("session-filter-button"));
    fireEvent.click(screen.getByRole("checkbox", { name: /1 turn · claude/i }));
    await waitFor(() => {
      const waypoints = screen.queryAllByTestId("map-waypoint");
      expect(waypoints).toHaveLength(3);
      // sA's turn is actionable (not faded); sB's two turns still are (faded).
      expect(waypoints.filter(isFaded).length).toBe(2);
    });
  });
});

// ——————————————————————————————————————————————————————————————————
// Legend: an "actionable" chip appears only while the filter is on.
// ——————————————————————————————————————————————————————————————————
describe("Legend / actionable chip", () => {
  afterEach(() => cleanup());

  it("shows the actionable chip when restorableOnly is on", () => {
    const { container, getByText } = render(
      <Legend nodeCount={3} sessionCount={1} totalSessionCount={1} view="map" restorableOnly />,
    );
    expect(container.querySelector(".legend-glyph-action")).toBeTruthy();
    expect(getByText(/actionable/i)).toBeTruthy();
  });

  it("hides the actionable chip when restorableOnly is off", () => {
    const { container } = render(
      <Legend nodeCount={3} sessionCount={1} totalSessionCount={1} view="map" restorableOnly={false} />,
    );
    expect(container.querySelector(".legend-glyph-action")).toBeNull();
  });
});

// ——————————————————————————————————————————————————————————————————
// Palette: the action hue is genuinely distinct from every kind token AND
// the restore-ready accent, in BOTH themes. jsdom resolves custom props off
// the injected stylesheet and honours data-theme, so this reads real values.
// ——————————————————————————————————————————————————————————————————
describe("CSS / action palette distinctness (getComputedStyle, both themes)", () => {
  beforeAll(() => {
    const style = document.createElement("style");
    style.id = "sojourn-styles-action";
    style.textContent = readFileSync(cssPath, "utf8");
    document.head.appendChild(style);
  });
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  const KINDS = [
    "prompt",
    "assistant",
    "tool_use",
    "tool_result",
    "decision",
    "assumption",
    "fork_point",
    "checkpoint",
  ];

  function tokens(theme: "light" | "dark") {
    document.documentElement.dataset.theme = theme;
    const cs = getComputedStyle(document.documentElement);
    const get = (name: string) => cs.getPropertyValue(name).trim().toLowerCase();
    return {
      action: get("--action"),
      restore: get("--restore-ready"),
      kinds: KINDS.map((k) => get(`--kind-${k}`)),
    };
  }

  for (const theme of ["light", "dark"] as const) {
    it(`--action is a real hex distinct from every kind + restore-ready in ${theme}`, () => {
      const { action, restore, kinds } = tokens(theme);
      expect(action).toMatch(/^#[0-9a-f]{6}$/);
      expect(action).not.toBe(restore);
      for (const k of kinds) expect(action).not.toBe(k);
    });
  }

  it("--action itself is theme-aware (light and dark values differ)", () => {
    const light = tokens("light").action;
    const dark = tokens("dark").action;
    expect(light).not.toBe(dark);
  });
});
