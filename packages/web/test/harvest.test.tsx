import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Inspector } from "../src/components/Inspector";
import { ApiError, api } from "../src/api";
import type {
  ChronoNode,
  HarvestOutcome,
  HarvestPartialState,
  HarvestPreflight,
  RestoreResult,
} from "../src/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WORKTREE = "/tmp/soj-worktrees/wt-1";

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

function makeRestoreResult(overrides: Partial<RestoreResult> = {}): RestoreResult {
  return {
    worktreePath: WORKTREE,
    safetySnapshotRef: "safety-restore",
    resumeCommand: null,
    warnings: [],
    ...overrides,
  };
}

function makeHarvestPreflight(overrides: Partial<HarvestPreflight> = {}): HarvestPreflight {
  return {
    worktreePath: WORKTREE,
    originNodeId: "claude:a",
    baseTree: "base-tree",
    branchTree: "branch-tree",
    files: [{ path: "src/a.ts", status: "clean" }],
    mainlineDirty: false,
    warnings: ["A safety snapshot of your project is taken before any write."],
    ...overrides,
  };
}

function makeHarvestOutcome(overrides: Partial<HarvestOutcome> = {}): HarvestOutcome {
  return {
    applied: [],
    conflicted: [],
    skippedIdentical: [],
    safetySnapshotRef: "safety-abc",
    patchPath: null,
    mergeNodeId: null,
    warnings: [],
    ...overrides,
  };
}

/**
 * Harvest is reachable ONLY from a restore result (the worktree path is the
 * one thing a restore hands the UI), so every test drives a restore first.
 */
async function renderHarvestFlow(preflight: HarvestPreflight) {
  vi.spyOn(api, "preflight").mockResolvedValue({
    nodeId: "claude:a",
    treeHash: "abc",
    treeValid: true,
    warnings: [],
    resumeCommand: null,
  });
  vi.spyOn(api, "restore").mockResolvedValue(makeRestoreResult());
  const preflightSpy = vi.spyOn(api, "harvestPreflight").mockResolvedValue(preflight);

  render(<Inspector node={makeNode("claude:a")} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: /restore at this node/i }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /confirm restore/i }));
  await waitFor(() => expect(screen.getByTestId("harvest-flow")).toBeTruthy());

  return { preflightSpy };
}

async function openHarvestModal(preflight: HarvestPreflight) {
  const handles = await renderHarvestFlow(preflight);
  fireEvent.click(screen.getByRole("button", { name: /harvest changes into project/i }));
  await waitFor(() => expect(screen.getByTestId("harvest-files")).toBeTruthy());
  return handles;
}

describe("HarvestFlow / preflight", () => {
  it("is reachable only from a restore result, and preflights that worktree", async () => {
    const { preflightSpy } = await openHarvestModal(makeHarvestPreflight());
    expect(preflightSpy).toHaveBeenCalledWith(WORKTREE);
  });

  it("renders the file table and the preflight warnings", async () => {
    await openHarvestModal(
      makeHarvestPreflight({
        files: [
          { path: "src/a.ts", status: "clean" },
          { path: "src/b.ts", status: "conflict" },
          { path: "src/c.ts", status: "identical" },
        ],
        warnings: ["warning-one", "warning-two"],
      }),
    );

    const rows = screen.getAllByTestId("harvest-file-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("src/a.ts");
    expect(rows[0]!.textContent).toContain("clean");
    expect(rows[1]!.textContent).toContain("conflict");
    expect(rows[2]!.textContent).toContain("identical");

    const warnings = screen.getByTestId("harvest-preflight-warnings");
    expect(warnings.textContent).toContain("warning-one");
    expect(warnings.textContent).toContain("warning-two");
  });

  it("labels mainlineDirty as 'moved on the files this harvest touches', not 'tree is dirty'", async () => {
    await openHarvestModal(makeHarvestPreflight({ mainlineDirty: true }));
    const notice = screen.getByTestId("harvest-mainline-dirty");
    expect(notice.textContent).toMatch(/files this harvest would touch/i);
  });

  it("does not show the dirty notice when the mainline has not moved", async () => {
    await openHarvestModal(makeHarvestPreflight({ mainlineDirty: false }));
    expect(screen.queryByTestId("harvest-mainline-dirty")).toBeNull();
  });
});

describe("HarvestFlow / conflict gating", () => {
  const conflicted = makeHarvestPreflight({
    files: [
      { path: "src/a.ts", status: "clean" },
      { path: "src/b.ts", status: "conflict" },
    ],
  });

  it("blocks confirm on conflicts until allow-conflicts is checked (mirrors the server refusal)", async () => {
    await openHarvestModal(conflicted);

    const confirm = screen.getByRole("button", { name: /confirm harvest/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /harvest anyway with 1 conflict/i }));
    expect((screen.getByRole("button", { name: /confirm harvest/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("describes allow-conflicts as 'write markers where possible', never as 'resolve'", async () => {
    await openHarvestModal(conflicted);
    const label = screen.getByRole("checkbox", { name: /harvest anyway/i }).closest("label")!;
    expect(label.textContent).toMatch(/conflict markers/i);
    expect(label.textContent).toMatch(/could not mark/i);
    expect(label.textContent).not.toMatch(/resolve/i);
  });

  it("passes the captured worktree path, mode, and allowConflicts through to the API", async () => {
    await openHarvestModal(conflicted);
    const harvestSpy = vi.spyOn(api, "harvest").mockResolvedValue(makeHarvestOutcome());

    fireEvent.click(screen.getByRole("checkbox", { name: /harvest anyway/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm harvest/i }));

    await waitFor(() => expect(harvestSpy).toHaveBeenCalledWith(WORKTREE, "apply", true));
  });

  it("does NOT block patch mode on conflicts — patch never touches the mainline", async () => {
    await openHarvestModal(conflicted);
    fireEvent.click(screen.getByRole("radio", { name: /^patch/i }));

    const confirm = screen.getByRole("button", { name: /confirm harvest/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });
});

describe("HarvestFlow / results", () => {
  it("renders patch mode by its patchPath, NOT as '0 files applied'", async () => {
    await openHarvestModal(makeHarvestPreflight());
    vi.spyOn(api, "harvest").mockResolvedValue(
      makeHarvestOutcome({ patchPath: `${WORKTREE}/sojourn-harvest.patch` }),
    );

    fireEvent.click(screen.getByRole("radio", { name: /^patch/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm harvest/i }));

    await waitFor(() => expect(screen.getByTestId("harvest-result")).toBeTruthy());
    expect(screen.getByTestId("harvest-patch-path").textContent).toBe(
      `${WORKTREE}/sojourn-harvest.patch`,
    );
    // The counts line — which would read "0 applied · 0 conflicted" — must
    // not be rendered at all for a successful patch run.
    expect(screen.queryByTestId("harvest-counts")).toBeNull();
    expect(screen.getByTestId("harvest-result").textContent).toMatch(/not modified/i);
  });

  it("renders apply-mode counts, the safety snapshot, and a null mergeNodeId without complaint", async () => {
    await openHarvestModal(makeHarvestPreflight());
    vi.spyOn(api, "harvest").mockResolvedValue(
      makeHarvestOutcome({
        applied: ["src/a.ts", "src/b.ts"],
        skippedIdentical: ["src/c.ts"],
        mergeNodeId: null,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm harvest/i }));

    await waitFor(() => expect(screen.getByTestId("harvest-counts")).toBeTruthy());
    expect(screen.getByTestId("harvest-counts").textContent).toContain("2 applied");
    expect(screen.getByTestId("harvest-counts").textContent).toContain("1 already identical");
    // mergeNodeId === null is legitimate, never an error.
    expect(screen.queryByTestId("harvest-error")).toBeNull();
    expect(screen.getByTestId("harvest-result").textContent).toContain("safety-abc");
  });

  it("ALWAYS renders result warnings — they are the only thing that says which conflicted files were left untouched", async () => {
    await openHarvestModal(
      makeHarvestPreflight({
        files: [
          { path: "src/a.ts", status: "clean" },
          { path: "assets/logo.png", status: "conflict" },
          { path: "src/b.ts", status: "conflict" },
        ],
      }),
    );
    vi.spyOn(api, "harvest").mockResolvedValue(
      makeHarvestOutcome({
        applied: ["src/a.ts"],
        conflicted: ["assets/logo.png", "src/b.ts"],
        warnings: ["assets/logo.png is binary — left untouched, no markers written"],
      }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /harvest anyway/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm harvest/i }));

    await waitFor(() => expect(screen.getByTestId("harvest-result-warnings")).toBeTruthy());
    expect(screen.getByTestId("harvest-result-warnings").textContent).toContain(
      "left untouched, no markers written",
    );
  });
});

describe("HarvestFlow / failures", () => {
  it("a 500 with `partial` reports what was written, what remains, and the recovery snapshot", async () => {
    await openHarvestModal(makeHarvestPreflight());

    const partial: HarvestPartialState = {
      applied: ["src/a.ts"],
      conflicted: [],
      remaining: ["src/b.ts", "src/c.ts"],
      safetySnapshotRef: "safety-recover-me",
    };
    vi.spyOn(api, "harvest").mockRejectedValue(
      new ApiError("Harvest failed mid-apply", 500, "partial_apply", ["src/b.ts"], partial),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm harvest/i }));

    await waitFor(() => expect(screen.getByTestId("harvest-partial")).toBeTruthy());
    const report = screen.getByTestId("harvest-partial");
    // Presented as "your project WAS modified", never as a generic failure.
    expect(report.textContent).toMatch(/project was modified/i);
    expect(screen.getByTestId("harvest-partial-applied").textContent).toContain("src/a.ts");
    expect(screen.getByTestId("harvest-partial-remaining").textContent).toContain("src/b.ts");
    expect(screen.getByTestId("harvest-partial-remaining").textContent).toContain("src/c.ts");
    expect(screen.getByTestId("harvest-partial-snapshot").textContent).toBe("safety-recover-me");
  });

  it("a 400 refusal shows the message and NO partial report (zero mainline writes)", async () => {
    await openHarvestModal(makeHarvestPreflight());
    vi.spyOn(api, "harvest").mockRejectedValue(
      new ApiError("Harvest aborted: 1 conflicted file(s)", 400, "conflicts", ["src/b.ts"]),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm harvest/i }));

    await waitFor(() => expect(screen.getByTestId("harvest-error")).toBeTruthy());
    expect(screen.getByTestId("harvest-error").textContent).toContain("Harvest aborted");
    expect(screen.queryByTestId("harvest-partial")).toBeNull();
  });

  it("survives a 400 that carries no `code` at all (plain input validation)", async () => {
    await openHarvestModal(makeHarvestPreflight());
    vi.spyOn(api, "harvest").mockRejectedValue(
      new ApiError("Body must include a string `worktreePath` field", 400),
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm harvest/i }));

    await waitFor(() => expect(screen.getByTestId("harvest-error")).toBeTruthy());
    expect(screen.getByTestId("harvest-error").textContent).toContain("worktreePath");
    expect(screen.queryByTestId("harvest-partial")).toBeNull();
  });
});

describe("api.request / error enrichment", () => {
  it("preserves code + partial on the thrown error while staying an Error with the same message", async () => {
    const partial: HarvestPartialState = {
      applied: ["a"],
      conflicted: [],
      remaining: ["b"],
      safetySnapshotRef: "snap",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "boom", code: "partial_apply", files: ["b"], partial }), {
          status: 500,
        }),
      ),
    );

    const err = await api.harvest("/wt", "apply").catch((e: unknown) => e);
    // Existing callers only ever do `e instanceof Error ? e.message : ...`.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("partial_apply");
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).partial).toEqual(partial);
    vi.unstubAllGlobals();
  });

  it("leaves code/partial null for an error body that has neither", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 })),
    );

    const err = (await api.harvest("/wt", "apply").catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe("bad request");
    expect(err.code).toBeNull();
    expect(err.partial).toBeNull();
    vi.unstubAllGlobals();
  });
});
