import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";
import { Inspector } from "../src/components/Inspector";
import { ApiError, api } from "../src/api";
import type {
  ChronoNode,
  CombinePartialState,
  CombinePreflight,
  CombineResult,
} from "../src/types";
import { FakeWebSocket, graphResponse, makeNode, makeSession, project } from "./harness";

const WORKTREE = "/tmp/soj-worktrees/combine-1";
const NODE_A = "claude:aaa";
const NODE_B = "claude:bbb";
const BASE = "claude:base";

// The daemon ALWAYS emits this (combineEngine.ts WARNING_FRESH_SESSION). It is
// rendered verbatim on top of the UI's own always-on notice.
const SERVER_FRESH_WARNING =
  "Combine produces FILES ONLY. No conversation transcript is synthesized — start a " +
  "genuinely fresh session in the output worktree; Sojourn will link it to node A automatically.";

function makePreflight(overrides: Partial<CombinePreflight> = {}): CombinePreflight {
  return {
    nodeIdA: NODE_A,
    nodeIdB: NODE_B,
    baseNodeId: BASE,
    baseTree: "tree-base",
    treeA: "tree-a",
    treeB: "tree-b",
    files: [{ path: "src/a.ts", status: "clean" }],
    warnings: [SERVER_FRESH_WARNING],
    ...overrides,
  };
}

function makeResult(overrides: Partial<CombineResult> = {}): CombineResult {
  return {
    worktreePath: WORKTREE,
    nodeIdA: NODE_A,
    nodeIdB: NODE_B,
    baseNodeId: BASE,
    baseTree: "tree-base",
    treeA: "tree-a",
    treeB: "tree-b",
    applied: [],
    conflicted: [],
    unmarkable: [],
    skippedIdentical: [],
    combineNodeId: null,
    warnings: [SERVER_FRESH_WARNING],
    ...overrides,
  };
}

/**
 * Component-level driver: the Inspector rendered with an explicit `markedNode`,
 * which is exactly the state App puts it in once a node is marked. The
 * cross-session mechanics get their own App-level test below.
 */
function renderInspectorWithMark(marked: ChronoNode | null = makeNode(NODE_B)) {
  render(
    <Inspector
      node={makeNode(NODE_A)}
      markedNode={marked}
      onMarkForCombine={() => {}}
      onFlagDismissed={() => {}}
      onAnnotationAdded={() => {}}
    />,
  );
}

async function openCombineModal(preflight: CombinePreflight) {
  const preflightSpy = vi.spyOn(api, "combinePreflight").mockResolvedValue(preflight);
  renderInspectorWithMark();
  fireEvent.click(screen.getByRole("button", { name: /combine with marked node/i }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  return { preflightSpy };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CombineFlow / preflight", () => {
  it("preflights the inspected node as A and the marked node as B", async () => {
    const { preflightSpy } = await openCombineModal(makePreflight());
    expect(preflightSpy).toHaveBeenCalledWith(NODE_A, NODE_B);
  });

  it("renders both node ids, the resolved merge base, and the per-file status table", async () => {
    await openCombineModal(
      makePreflight({
        files: [
          { path: "src/a.ts", status: "clean" },
          { path: "src/b.ts", status: "conflict" },
          { path: "src/c.ts", status: "identical" },
        ],
      }),
    );

    const ids = screen.getByTestId("combine-ids");
    expect(ids.textContent).toContain(NODE_A);
    expect(ids.textContent).toContain(NODE_B);
    // The merge base is named AND explained — an unlabelled third id would be
    // meaningless to the user.
    expect(screen.getByTestId("combine-base-node").textContent).toBe(BASE);
    expect(ids.textContent).toMatch(/nearest common ancestor/i);

    const rows = screen.getAllByTestId("combine-file-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("src/a.ts");
    expect(rows[0]!.textContent).toContain("clean");
    expect(rows[1]!.textContent).toContain("conflict");
    expect(rows[2]!.textContent).toContain("identical");
  });

  it("renders the server's warnings verbatim alongside the UI's own notice", async () => {
    await openCombineModal(makePreflight({ warnings: [SERVER_FRESH_WARNING, "extra-note"] }));
    const warnings = screen.getByTestId("combine-preflight-warnings");
    expect(warnings.textContent).toContain(SERVER_FRESH_WARNING);
    expect(warnings.textContent).toContain("extra-note");
  });

  it("is offered only when a DIFFERENT node is marked", async () => {
    // Nothing marked: the mark action is offered, combining is not.
    renderInspectorWithMark(null);
    expect(screen.getByRole("button", { name: /mark for combine/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /combine with marked node/i })).toBeNull();
    cleanup();

    // The inspected node IS the marked one — combining a node with itself is a
    // server 400, so it is never offered (and re-marking it is pointless).
    render(
      <Inspector
        node={makeNode(NODE_A)}
        markedNode={makeNode(NODE_A)}
        onMarkForCombine={() => {}}
        onFlagDismissed={() => {}}
        onAnnotationAdded={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /combine with marked node/i })).toBeNull();
    expect(screen.queryByTestId("combine-mark-section")).toBeNull();
  });
});

describe("CombineFlow / the fresh-session truth", () => {
  it("states 'files only, no conversation, fresh session' in the modal — always, warnings or not", async () => {
    // Even with the server's warning list EMPTY, the notice still renders: it
    // is the UI's own copy, not a pass-through of `warnings`.
    await openCombineModal(makePreflight({ warnings: [] }));
    const notice = screen.getByTestId("combine-fresh-session-notice");
    expect(notice.textContent).toMatch(/files only/i);
    expect(notice.textContent).toMatch(/no conversation is combined/i);
    expect(notice.textContent).toMatch(/genuinely fresh session/i);
    expect(notice.textContent).toMatch(/transcript/i);
    expect(screen.queryByTestId("combine-preflight-warnings")).toBeNull();
  });

  it("repeats it on the RESULT, where the user is about to open the worktree", async () => {
    await openCombineModal(makePreflight({ warnings: [] }));
    vi.spyOn(api, "combine").mockResolvedValue(makeResult({ warnings: [] }));

    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));

    await waitFor(() => expect(screen.getByTestId("combine-result")).toBeTruthy());
    const notice = screen.getByTestId("combine-fresh-session-notice");
    expect(notice.textContent).toMatch(/no conversation is combined/i);
    expect(notice.textContent).toMatch(/genuinely fresh session/i);
  });
});

describe("CombineFlow / conflict gating", () => {
  const conflicted = makePreflight({
    files: [
      { path: "src/a.ts", status: "clean" },
      { path: "src/b.ts", status: "conflict" },
    ],
  });

  it("shows NO allow-conflicts checkbox when the merge is clean", async () => {
    await openCombineModal(makePreflight());
    expect(screen.queryByRole("checkbox", { name: /combine anyway/i })).toBeNull();
    // …and confirm is live, since there is nothing to refuse.
    expect(
      (screen.getByRole("button", { name: /confirm combine/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("blocks confirm on conflicts until allow-conflicts is checked (mirrors the server refusal)", async () => {
    await openCombineModal(conflicted);

    const checkbox = screen.getByRole("checkbox", { name: /combine anyway with 1 conflict/i });
    expect(
      (screen.getByRole("button", { name: /confirm combine/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(checkbox);
    expect(
      (screen.getByRole("button", { name: /confirm combine/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("warns in the checkbox label when a conflict can never take markers", async () => {
    await openCombineModal(
      makePreflight({
        files: [
          { path: "src/b.ts", status: "conflict" },
          { path: "assets/logo.png", status: "conflict", unmarkable: true },
        ],
      }),
    );
    const label = screen.getByRole("checkbox", { name: /combine anyway/i }).closest("label")!;
    expect(label.textContent).toMatch(/2 conflict/);
    expect(label.textContent).toMatch(/1 file\(s\) cannot take markers/i);
    expect(label.textContent).toMatch(/A's content is kept as-is/i);
    // The per-file row says so too.
    const rows = screen.getAllByTestId("combine-file-row");
    expect(rows[1]!.textContent).toMatch(/cannot take conflict markers/i);
  });

  it("passes the CAPTURED pair and allowConflicts through to the API", async () => {
    await openCombineModal(conflicted);
    const combineSpy = vi.spyOn(api, "combine").mockResolvedValue(makeResult());

    fireEvent.click(screen.getByRole("checkbox", { name: /combine anyway/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));

    await waitFor(() => expect(combineSpy).toHaveBeenCalledWith(NODE_A, NODE_B, true));
  });
});

describe("CombineFlow / results", () => {
  it("shows the worktree path prominently and every group DISTINCTLY", async () => {
    await openCombineModal(makePreflight());
    vi.spyOn(api, "combine").mockResolvedValue(
      makeResult({
        applied: ["src/a.ts"],
        conflicted: ["src/b.ts"],
        unmarkable: ["assets/logo.png"],
        skippedIdentical: ["src/c.ts"],
        combineNodeId: "claude:combine-1",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));

    await waitFor(() => expect(screen.getByTestId("combine-result")).toBeTruthy());
    expect(screen.getByTestId("combine-worktree").textContent).toBe(WORKTREE);
    expect(screen.getByTestId("combine-applied").textContent).toContain("src/a.ts");
    expect(screen.getByTestId("combine-skipped-identical").textContent).toContain("src/c.ts");
    expect(screen.getByTestId("combine-node-id").textContent).toBe("claude:combine-1");
    expect(screen.getByTestId("combine-result-warnings").textContent).toContain(
      SERVER_FRESH_WARNING,
    );
  });

  it("renders `unmarkable` as its own group — NOT folded into `conflicted`", async () => {
    await openCombineModal(makePreflight());
    vi.spyOn(api, "combine").mockResolvedValue(
      // The REAL engine shape: `unmarkable` is a SUBSET of `conflicted` (the
      // engine pushes those paths into both arrays). An earlier version of this
      // fixture used DISJOINT arrays — a shape the engine can never emit — so
      // the assertions below passed trivially and could not catch the binary
      // path being rendered in both groups at once.
      makeResult({
        conflicted: ["src/b.ts", "assets/logo.png"],
        unmarkable: ["assets/logo.png"],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));

    await waitFor(() => expect(screen.getByTestId("combine-result")).toBeTruthy());
    const conflictedGroup = screen.getByTestId("combine-conflicted");
    const unmarkableGroup = screen.getByTestId("combine-unmarkable");
    expect(conflictedGroup).not.toBe(unmarkableGroup);

    // Marked files are in `conflicted` and ONLY there.
    expect(conflictedGroup.textContent).toContain("src/b.ts");
    expect(conflictedGroup.textContent).not.toContain("assets/logo.png");
    // Unmarkable files are in `unmarkable` and ONLY there.
    expect(unmarkableGroup.textContent).toContain("assets/logo.png");
    expect(unmarkableGroup.textContent).not.toContain("src/b.ts");

    // The two groups say materially different things about the file contents.
    const result = screen.getByTestId("combine-result");
    expect(result.textContent).toMatch(/written with conflict markers/i);
    expect(result.textContent).toMatch(/A's content kept as-is/i);
  });

  it("treats combineNodeId === null as an ordinary outcome, not an error", async () => {
    await openCombineModal(makePreflight());
    vi.spyOn(api, "combine").mockResolvedValue(
      makeResult({ applied: ["src/a.ts"], combineNodeId: null }),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));

    await waitFor(() => expect(screen.getByTestId("combine-result")).toBeTruthy());
    expect(screen.queryByTestId("combine-node-id")).toBeNull();
    expect(screen.queryByTestId("combine-error")).toBeNull();
  });
});

describe("CombineFlow / failures", () => {
  it("a 500 with `partial` reports the half-built worktree and exactly what landed", async () => {
    await openCombineModal(makePreflight());

    const partial: CombinePartialState = {
      worktreePath: WORKTREE,
      applied: ["src/a.ts"],
      conflicted: ["src/b.ts"],
      remaining: ["src/c.ts", "src/d.ts"],
    };
    vi.spyOn(api, "combine").mockRejectedValue(
      new ApiError("Combine failed mid-write", 500, "write_failed", ["src/c.ts"], partial),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));

    await waitFor(() => expect(screen.getByTestId("combine-partial")).toBeTruthy());
    const report = screen.getByTestId("combine-partial");
    // Framed as recovery ("here is what landed and where"), never a bare error.
    expect(report.textContent).toMatch(/partially built/i);
    expect(report.textContent).toMatch(/kept on purpose/i);
    expect(screen.getByTestId("combine-partial-worktree").textContent).toBe(WORKTREE);
    expect(screen.getByTestId("combine-partial-applied").textContent).toContain("src/a.ts");
    expect(screen.getByTestId("combine-partial-conflicted").textContent).toContain("src/b.ts");
    const remaining = screen.getByTestId("combine-partial-remaining").textContent!;
    expect(remaining).toContain("src/c.ts");
    expect(remaining).toContain("src/d.ts");
  });

  it("a 400 refusal shows the message and NO partial report (zero bytes written)", async () => {
    await openCombineModal(makePreflight());
    vi.spyOn(api, "combine").mockRejectedValue(
      new ApiError("No common ancestor for these nodes", 400, "no_common_ancestor"),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));

    await waitFor(() => expect(screen.getByTestId("combine-error")).toBeTruthy());
    expect(screen.getByTestId("combine-error").textContent).toContain("No common ancestor");
    expect(screen.queryByTestId("combine-partial")).toBeNull();
  });

  it("survives a body-validation 400 that carries NO `code` at all", async () => {
    const spy = vi
      .spyOn(api, "combinePreflight")
      .mockRejectedValue(new ApiError("Body must include a non-empty string `nodeIdB` field", 400));
    renderInspectorWithMark();

    fireEvent.click(screen.getByRole("button", { name: /combine with marked node/i }));

    await waitFor(() => expect(screen.getByTestId("combine-error")).toBeTruthy());
    expect(spy).toHaveBeenCalled();
    expect(screen.getByTestId("combine-error").textContent).toContain("nodeIdB");
    expect(screen.queryByTestId("combine-partial")).toBeNull();
  });
});

// ——— App-level: the headline case. Marking must survive BOTH a selection
// change and a session-filter change, because the two nodes live in different
// sessions and only one session is shown at a time by default.
describe("App / mark in one session, combine with a node in ANOTHER", () => {
  const sessionA = makeSession("sA", "2026-07-01T10:00:00.000Z", ["prompt", "assistant"]);
  const sessionB = makeSession("sB", "2026-07-02T10:00:00.000Z", ["prompt", "assistant"]);

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderApp() {
    vi.spyOn(api, "listProjects").mockResolvedValue([project]);
    vi.spyOn(api, "getGraph").mockResolvedValue(graphResponse([...sessionA, ...sessionB]));
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "test" });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("legend")).toBeTruthy());
    await waitFor(() => expect(screen.queryAllByTestId("map-waypoint").length).toBe(1));
  }

  /**
   * Open the (single) visible turn and select one of its nodes by summary.
   * Clicking a waypoint TOGGLES its drawer, so only click when it's closed —
   * otherwise selecting a second node in the same turn would close it.
   */
  async function selectNode(summary: string) {
    if (!screen.queryByTestId("turn-drawer")) {
      fireEvent.click(screen.getAllByTestId("map-waypoint")[0]!);
    }
    const drawer = await waitFor(() => screen.getByTestId("turn-drawer"));
    // Scoped to the drawer: the Inspector's Path breadcrumbs carry the very
    // same summaries, so an unscoped query would be ambiguous.
    fireEvent.click(within(drawer).getByRole("button", { name: new RegExp(summary) }));
    await waitFor(() => expect(screen.getByTestId("inspector")).toBeTruthy());
  }

  /** Swap the session filter from the default (newest only) to sA only. */
  function showOnlySessionA() {
    fireEvent.click(screen.getByTestId("session-filter-button"));
    const rows = screen.getAllByTestId("session-filter-row");
    // Rows are newest-first: [sB, sA].
    fireEvent.click(rows[1]!.querySelector("input")!); // add sA
    fireEvent.click(rows[0]!.querySelector("input")!); // drop sB
    fireEvent.click(screen.getByTestId("session-filter-button")); // close popover
  }

  it("carries the mark across the selection AND the session filter, then combines the pair", async () => {
    const preflightSpy = vi.spyOn(api, "combinePreflight").mockResolvedValue(
      makePreflight({ nodeIdA: "sA-n1", nodeIdB: "sB-n1", baseNodeId: BASE }),
    );
    const combineSpy = vi
      .spyOn(api, "combine")
      .mockResolvedValue(makeResult({ nodeIdA: "sA-n1", nodeIdB: "sB-n1" }));

    await renderApp();

    // 1. Mark a node in session B (the only session shown by default).
    await selectNode("node sB-n1");
    fireEvent.click(screen.getByRole("button", { name: /mark for combine/i }));
    const banner = await screen.findByTestId("marked-node-banner");
    expect(banner.textContent).toContain("node sB-n1");

    // 2. Change the session filter so session B is HIDDEN entirely. The mark
    //    must survive — it lives in App state, resolved against all nodes.
    showOnlySessionA();
    await waitFor(() => expect(screen.queryAllByTestId("map-waypoint").length).toBe(1));
    expect(screen.getByTestId("marked-node-banner").textContent).toContain("node sB-n1");

    // 3. Select a node in session A — a different session, different node.
    await selectNode("node sA-n1");
    expect(screen.getByTestId("marked-node-banner").textContent).toContain("node sB-n1");
    expect(screen.getByTestId("combine-partner").textContent).toContain("node sB-n1");

    // 4. Combine: A is the freshly selected node, B is the one marked earlier.
    fireEvent.click(screen.getByRole("button", { name: /combine with marked node/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(preflightSpy).toHaveBeenCalledWith("sA-n1", "sB-n1");

    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));
    await waitFor(() => expect(combineSpy).toHaveBeenCalledWith("sA-n1", "sB-n1", false));
    await waitFor(() => expect(screen.getByTestId("combine-worktree").textContent).toBe(WORKTREE));
  });

  it("the marked-node indicator can be cleared, which retracts the combine offer", async () => {
    await renderApp();
    await selectNode("node sB-n1");
    fireEvent.click(screen.getByRole("button", { name: /mark for combine/i }));
    await screen.findByTestId("marked-node-banner");

    // Selecting the OTHER node in the same turn surfaces the combine offer…
    await selectNode("node sB-n0");
    expect(screen.getByRole("button", { name: /combine with marked node/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => expect(screen.queryByTestId("marked-node-banner")).toBeNull());
    expect(screen.queryByRole("button", { name: /combine with marked node/i })).toBeNull();
    // …and the mark action comes back.
    expect(screen.getByRole("button", { name: /mark for combine/i })).toBeTruthy();
  });

  it("does NOT insert the combine node itself — that arrives over the WS broadcast", async () => {
    vi.spyOn(api, "combinePreflight").mockResolvedValue(
      makePreflight({ nodeIdA: "sB-n0", nodeIdB: "sB-n1" }),
    );
    vi.spyOn(api, "combine").mockResolvedValue(
      makeResult({ nodeIdA: "sB-n0", nodeIdB: "sB-n1", combineNodeId: "claude:combine-9" }),
    );
    await renderApp();

    await selectNode("node sB-n1");
    fireEvent.click(screen.getByRole("button", { name: /mark for combine/i }));
    await selectNode("node sB-n0");
    fireEvent.click(screen.getByRole("button", { name: /combine with marked node/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /confirm combine/i }));
    await waitFor(() => expect(screen.getByTestId("combine-result")).toBeTruthy());

    // The legend counts the SHOWN session (sB): still its original 2 nodes —
    // result.combineNodeId was NOT inserted into the graph by the UI.
    expect(screen.getByTestId("legend").textContent).toContain("2 steps");

    // The daemon's broadcast is what puts it in the graph.
    const combineNode = makeNode("claude:combine-9", {
      kind: "checkpoint",
      sessionId: "sB",
      parentId: "sB-n0",
      timestamp: "2026-07-02T10:05:00.000Z",
      meta: { nativeUuid: "combine-9", mergedFrom: "sB-n1" },
    });
    FakeWebSocket.instances
      .at(-1)!
      .emit("message", { data: JSON.stringify({ type: "node_added", node: combineNode }) });

    await waitFor(() => expect(screen.getByTestId("legend").textContent).toContain("3 steps"));
  });
});
