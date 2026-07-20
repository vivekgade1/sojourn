import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App";
import { api } from "../src/api";
import { layoutGraph } from "../src/layout";
import type { ChronoNode } from "../src/types";
import { FakeWebSocket, graphResponse, makeSession, project } from "./harness";

// Wrap layoutGraph so tests can assert on the ACTUAL layout input — the perf
// claim is "filtered before layout", not "hidden by CSS afterwards".
vi.mock("../src/layout", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/layout")>();
  return { ...mod, layoutGraph: vi.fn(mod.layoutGraph) };
});
const layoutSpy = vi.mocked(layoutGraph);

const STORAGE_KEY = `sojourn:session-filter:${project.id}`;

// Session A (older, claude): 2 turns / 5 nodes. Session B (newer, claude):
// 3 turns / 6 nodes. Session C (oldest, opencode): 1 turn / 2 nodes.
const sessionA = makeSession("sA", "2026-07-01T10:00:00.000Z", [
  "prompt",
  "tool_use",
  "assistant",
  "prompt",
  "assistant",
]);
const sessionB = makeSession("sB", "2026-07-02T10:00:00.000Z", [
  "prompt",
  "assistant",
  "prompt",
  "assistant",
  "prompt",
  "assistant",
]);
const sessionC = makeSession("sC", "2026-06-30T10:00:00.000Z", ["prompt", "assistant"], "opencode");

function stubApi(nodes: ChronoNode[]) {
  vi.spyOn(api, "listProjects").mockResolvedValue([project]);
  vi.spyOn(api, "getGraph").mockResolvedValue(graphResponse(nodes));
  vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "test" });
}

async function renderApp(nodes: ChronoNode[]) {
  stubApi(nodes);
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("legend")).toBeTruthy());
  await waitFor(() => expect(vi.mocked(api.getGraph)).toHaveBeenCalled());
}

function openFilter() {
  fireEvent.click(screen.getByTestId("session-filter-button"));
}

function waypointCount(): number {
  return screen.queryAllByTestId("map-waypoint").length;
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

describe("App / session filter — defaults", () => {
  it("shows ONLY the newest session by default, with an honest legend count", async () => {
    await renderApp([...sessionA, ...sessionB]);

    // Only session B's 3 turns are laid out on the map.
    await waitFor(() => expect(waypointCount()).toBe(3));
    const legend = screen.getByTestId("legend");
    expect(legend.textContent).toContain("6 steps");
    expect(legend.textContent).toContain("1 of 2 sessions");
  });

  it("lists sessions newest-first with start time, turn count, and cli", async () => {
    await renderApp([...sessionA, ...sessionB, ...sessionC]);
    openFilter();

    const rows = screen.getAllByTestId("session-filter-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toMatch(/3 turns/);
    expect(rows[0]!.textContent).toMatch(/claude/);
    expect(rows[1]!.textContent).toMatch(/2 turns/);
    expect(rows[2]!.textContent).toMatch(/1 turn\b/);
    expect(rows[2]!.textContent).toMatch(/opencode/);

    // Default: only the newest is checked.
    const boxes = screen.getAllByRole("checkbox").filter((el) =>
      el.closest('[data-testid="session-filter-row"]'),
    ) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
  });
});

describe("App / session filter — multi-select and All", () => {
  it("unions the selected sessions in the map view", async () => {
    await renderApp([...sessionA, ...sessionB]);
    await waitFor(() => expect(waypointCount()).toBe(3));

    openFilter();
    fireEvent.click(screen.getByRole("checkbox", { name: /2 turns · claude/ }));

    await waitFor(() => expect(waypointCount()).toBe(5));
    const legend = screen.getByTestId("legend");
    expect(legend.textContent).toContain("11 steps");
    expect(legend.textContent).toContain("2 sessions");
  });

  it("'All' selects every session", async () => {
    await renderApp([...sessionA, ...sessionB, ...sessionC]);
    await waitFor(() => expect(waypointCount()).toBe(3));

    openFilter();
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));

    await waitFor(() => expect(waypointCount()).toBe(6));
    expect(screen.getByTestId("legend").textContent).toContain("13 steps");
    expect(screen.getByTestId("legend").textContent).toContain("3 sessions");
  });

  it("deselecting every session falls back to latest-only", async () => {
    await renderApp([...sessionA, ...sessionB]);
    openFilter();
    // Uncheck the (only-selected) newest session.
    fireEvent.click(screen.getByRole("checkbox", { name: /3 turns · claude/ }));
    await waitFor(() => expect(waypointCount()).toBe(3));
  });
});

describe("App / session filter — the filtered set feeds LAYOUT", () => {
  it("graph view lays out only the selected sessions' nodes", async () => {
    await renderApp([...sessionA, ...sessionB]);
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));

    // Default = newest only: layout input is session B's 6 nodes.
    await waitFor(() => {
      expect(layoutSpy).toHaveBeenCalled();
      expect(layoutSpy.mock.calls.at(-1)![0]).toHaveLength(6);
    });

    openFilter();
    fireEvent.click(screen.getByRole("checkbox", { name: /2 turns · claude/ }));

    await waitFor(() => expect(layoutSpy.mock.calls.at(-1)![0]).toHaveLength(11));
  });
});

describe("App / session filter — persistence", () => {
  it("persists the selection per project and restores it on reload", async () => {
    await renderApp([...sessionA, ...sessionB]);
    openFilter();
    fireEvent.click(screen.getByRole("checkbox", { name: /2 turns · claude/ }));
    await waitFor(() => expect(waypointCount()).toBe(5));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as string[];
    expect(new Set(stored)).toEqual(new Set(["sA", "sB"]));

    // Reload: a fresh App restores the stored selection.
    cleanup();
    vi.restoreAllMocks();
    await renderApp([...sessionA, ...sessionB]);
    await waitFor(() => expect(waypointCount()).toBe(5));
  });

  it("falls back to latest-only when the stored ids no longer exist", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["s-ghost"]));
    await renderApp([...sessionA, ...sessionB]);
    await waitFor(() => expect(waypointCount()).toBe(3));
    expect(screen.getByTestId("legend").textContent).toContain("1 of 2 sessions");
  });
});

describe("App / session filter — the 'new sessions hidden' nudge", () => {
  // Session D arrives live, over the WS, after an explicit selection is in
  // place. effectiveSessionIds intersects the stored ids with what exists, so
  // D is dropped silently — the banner is the only thing that surfaces it.
  const sessionD = makeSession("sD", "2026-07-03T10:00:00.000Z", ["prompt", "assistant"]);

  function pushNodes(nodes: ChronoNode[]) {
    const ws = FakeWebSocket.instances.at(-1)!;
    for (const node of nodes) {
      ws.emit("message", { data: JSON.stringify({ type: "node_added", node }) });
    }
  }

  async function renderWithExplicitSelection() {
    await renderApp([...sessionA, ...sessionB]);
    await waitFor(() => expect(waypointCount()).toBe(3));
    // Explicitly select BOTH sessions — this is the state that hides new ones.
    openFilter();
    fireEvent.click(screen.getByRole("checkbox", { name: /2 turns · claude/ }));
    await waitFor(() => expect(waypointCount()).toBe(5));
    // Close the popover so its rows don't collide with banner queries.
    fireEvent.click(screen.getByTestId("session-filter-button"));
  }

  it("does not fire on first mount — historical unselected sessions are not 'new'", async () => {
    // A+B+C exist, but only B is selected (the default). C and A are old, not new.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["sB"]));
    await renderApp([...sessionA, ...sessionB, ...sessionC]);
    await waitFor(() => expect(waypointCount()).toBe(3));

    expect(screen.queryByTestId("new-sessions-banner")).toBeNull();
  });

  it("does not fire on the DEFAULT path — effectiveSessionIds already re-picks the newest", async () => {
    await renderApp([...sessionA, ...sessionB]);
    await waitFor(() => expect(waypointCount()).toBe(3));
    // No stored selection: storedSessionIds === null.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    pushNodes(sessionD);
    // The new session becomes the newest and is shown automatically.
    await waitFor(() => expect(waypointCount()).toBe(1));
    expect(screen.queryByTestId("new-sessions-banner")).toBeNull();
  });

  it("nudges (without changing the layout input) when an explicit selection hides a new session", async () => {
    await renderWithExplicitSelection();

    pushNodes(sessionD);

    const banner = await screen.findByTestId("new-sessions-banner");
    expect(banner.textContent).toMatch(/1 new session/i);
    // The whole point of the nudge over auto-include: nothing extra was laid out.
    expect(waypointCount()).toBe(5);
  });

  it("the include action widens the selection AND persists the new id", async () => {
    await renderWithExplicitSelection();
    pushNodes(sessionD);
    await screen.findByTestId("new-sessions-banner");

    fireEvent.click(screen.getByRole("button", { name: /show it/i }));

    // sD's single turn joins the 5 already on the map.
    await waitFor(() => expect(waypointCount()).toBe(6));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as string[];
    expect(new Set(stored)).toEqual(new Set(["sA", "sB", "sD"]));
    expect(screen.queryByTestId("new-sessions-banner")).toBeNull();
  });

  it("dismiss acknowledges without touching the selection, and does not come back", async () => {
    await renderWithExplicitSelection();
    pushNodes(sessionD);
    await screen.findByTestId("new-sessions-banner");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(screen.queryByTestId("new-sessions-banner")).toBeNull());
    expect(waypointCount()).toBe(5);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as string[];
    expect(new Set(stored)).toEqual(new Set(["sA", "sB"]));
  });
});

describe("App / session filter — search scopes to selected sessions", () => {
  it("search only matches within the selected sessions", async () => {
    const needleNodes = sessionA.map((n, i) =>
      i === 2 ? { ...n, summary: "needle-alpha" } : n,
    );
    await renderApp([...needleNodes, ...sessionB]);
    await waitFor(() => expect(waypointCount()).toBe(3));

    const input = screen.getByLabelText("Search nodes");
    fireEvent.change(input, { target: { value: "needle-alpha" } });
    await waitFor(() =>
      expect(screen.getByTestId("search-count").textContent).toBe("0 matches"),
    );

    openFilter();
    fireEvent.click(screen.getByRole("checkbox", { name: /2 turns · claude/ }));
    await waitFor(() =>
      expect(screen.getByTestId("search-count").textContent).toBe("1 / 1"),
    );
  });
});
