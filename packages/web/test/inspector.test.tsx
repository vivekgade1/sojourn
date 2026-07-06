import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Inspector } from "../src/components/Inspector";
import { api } from "../src/api";
import type { Annotation, ChronoNode, RestorePreflight, StoredFlag } from "../src/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

function makePreflight(nodeId: string, overrides: Partial<RestorePreflight> = {}): RestorePreflight {
  return {
    nodeId,
    treeHash: "abc123",
    treeValid: true,
    warnings: [`warning for ${nodeId}`],
    resumeCommand: null,
    ...overrides,
  };
}

describe("Inspector / RestoreFlow node-switch safety", () => {
  it("resets restore/preflight state when the selected node changes (keyed remount)", async () => {
    const nodeA = makeNode("claude:a");
    const nodeB = makeNode("claude:b");

    const preflightSpy = vi
      .spyOn(api, "preflight")
      .mockImplementation(async (nodeId: string) => makePreflight(nodeId));
    const restoreSpy = vi.spyOn(api, "restore");

    const { rerender } = render(
      <Inspector node={nodeA} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />,
    );

    // Open the preflight modal for node A.
    fireEvent.click(screen.getByRole("button", { name: /restore at this node/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(preflightSpy).toHaveBeenCalledWith("claude:a");
    expect(screen.getByText("warning for claude:a")).toBeTruthy();

    // Switch the selected node to B — Inspector must remount its content
    // (key={node.id}) so the modal/preflight state from A is discarded.
    rerender(<Inspector node={nodeB} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /restore at this node/i })).toBeTruthy();

    // Confirming now must never be possible without a fresh preflight, and
    // if a fresh preflight is started it must be scoped to node B, never A.
    fireEvent.click(screen.getByRole("button", { name: /restore at this node/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(preflightSpy).toHaveBeenCalledWith("claude:b");
    expect(screen.getByText("warning for claude:b")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /confirm restore/i }));
    await waitFor(() => expect(restoreSpy).toHaveBeenCalled());
    expect(restoreSpy).toHaveBeenCalledWith("claude:b");
    expect(restoreSpy).not.toHaveBeenCalledWith("claude:a");
  });

  it("passes the id captured at preflight time to restore, not the current prop id", async () => {
    const node = makeNode("claude:x");
    vi.spyOn(api, "preflight").mockResolvedValue(makePreflight("claude:x"));
    const restoreSpy = vi.spyOn(api, "restore").mockResolvedValue({
      worktreePath: "/tmp/wt",
      safetySnapshotRef: "ref",
      resumeCommand: null,
      warnings: [],
    });

    render(<Inspector node={node} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /restore at this node/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /confirm restore/i }));
    await waitFor(() => expect(restoreSpy).toHaveBeenCalledWith("claude:x"));
  });
});

describe("Inspector / Annotations section", () => {
  it("renders existing annotations (text + createdAt)", () => {
    const node = makeNode("claude:ann1", {
      annotations: [
        { id: 1, nodeId: "claude:ann1", text: "first note", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: 2, nodeId: "claude:ann1", text: "second note", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    });

    render(<Inspector node={node} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />);

    expect(screen.getByText("first note")).toBeTruthy();
    expect(screen.getByText("second note")).toBeTruthy();
  });

  it("submits a new annotation via api.addAnnotation and notifies the parent", async () => {
    const node = makeNode("claude:ann2", { annotations: [] });
    const newAnnotation: Annotation = {
      id: 99,
      nodeId: "claude:ann2",
      text: "hello world",
      createdAt: "2026-01-03T00:00:00.000Z",
    };
    const addSpy = vi.spyOn(api, "addAnnotation").mockResolvedValue(newAnnotation);
    const onAnnotationAdded = vi.fn();

    render(
      <Inspector node={node} onFlagDismissed={() => {}} onAnnotationAdded={onAnnotationAdded} />,
    );

    const input = screen.getByPlaceholderText(/add an annotation/i);
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith("claude:ann2", "hello world"));
    await waitFor(() => expect(onAnnotationAdded).toHaveBeenCalledWith("claude:ann2", newAnnotation));
  });

  it("does not submit an empty annotation", () => {
    const node = makeNode("claude:ann3", { annotations: [] });
    const addSpy = vi.spyOn(api, "addAnnotation");

    render(<Inspector node={node} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />);

    const addButton = screen.getByRole("button", { name: /^add$/i });
    expect(addButton).toHaveProperty("disabled", true);
    fireEvent.click(addButton);
    expect(addSpy).not.toHaveBeenCalled();
  });
});

function makeStoredFlag(overrides: Partial<StoredFlag> = {}): StoredFlag {
  return {
    id: 1,
    nodeId: "claude:f1",
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence: "high",
    evidence: "claimed edit to `auth.py`; snapshot diff shows no change to that file",
    source: "deterministic",
    dismissed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Inspector / advisory critic button", () => {
  it("runs the T2 critic via api.runFlags and renders the returned advisory flag", async () => {
    const node = makeNode("claude:critic1", { kind: "assistant" });
    const advisory = makeStoredFlag({
      id: 7,
      nodeId: "claude:critic1",
      kind: "unstated_assumption",
      tier: "advisory",
      confidence: "medium",
      evidence: "Assumed: the default branch is main",
      source: "llm_critic",
    });
    const runSpy = vi.spyOn(api, "runFlags").mockResolvedValue({ flags: [advisory] });
    const onFlagsUpdated = vi.fn();

    render(
      <Inspector
        node={node}
        onFlagDismissed={() => {}}
        onAnnotationAdded={() => {}}
        onFlagsUpdated={onFlagsUpdated}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /run advisory critic/i }));

    await waitFor(() => expect(runSpy).toHaveBeenCalledWith("claude:critic1", "T2"));
    // The FULL flag list returned by the daemon is handed to the parent
    // (replace semantics), which owns node.flags.
    await waitFor(() =>
      expect(onFlagsUpdated).toHaveBeenCalledWith("claude:critic1", [advisory]),
    );
  });

  it("renders advisory styling for advisory flags and shows the daemon error cleanly on failure", async () => {
    const advisory = makeStoredFlag({
      id: 8,
      kind: "unstated_assumption",
      tier: "advisory",
      confidence: "low",
      evidence: "Assumed: tests cover the edge cases",
      source: "llm_critic",
    });
    const node = makeNode("claude:critic2", { kind: "assistant", flags: [advisory] });
    vi.spyOn(api, "runFlags").mockRejectedValue(new Error("T2 requires ANTHROPIC_API_KEY"));

    const { container } = render(
      <Inspector node={node} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />,
    );

    // Advisory flag renders with the advisory (never verified) row class.
    expect(container.querySelector(".flag-row-advisory")).toBeTruthy();
    expect(container.querySelector(".flag-row-advisory.flag-row-verified")).toBeNull();
    expect(screen.getByText("Advisory")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /run advisory critic/i }));
    await waitFor(() =>
      expect(screen.getByText("T2 requires ANTHROPIC_API_KEY")).toBeTruthy(),
    );
  });
});

describe("Inspector / auto-resolved flags", () => {
  it("renders auto-resolved flags in a resolved state, labeled and excluded from the active count", () => {
    const active = makeStoredFlag({ id: 1, evidence: "claimed edit to `a.ts`; no change" });
    const resolved = makeStoredFlag({
      id: 2,
      evidence: "claimed edit to `b.ts`; no change",
      autoResolved: true,
    });
    const node = makeNode("claude:res1", { kind: "assistant", flags: [active, resolved] });

    render(<Inspector node={node} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />);

    // Active count excludes the resolved flag.
    expect(screen.getByText("Flags (1)")).toBeTruthy();
    // Resolved flag renders, visually distinct and labeled.
    const resolvedRow = screen.getByTestId("flag-row-resolved");
    expect(resolvedRow.className).toMatch(/flag-row-resolved/);
    expect(screen.getByText("auto-resolved")).toBeTruthy();
  });
});

describe("Inspector / flag-context restore targets the parent", () => {
  it("'Restore to before this node' preflights the PARENT node id", async () => {
    const flagged = makeNode("claude:child", {
      kind: "assistant",
      parentId: "claude:parent",
      flags: [makeStoredFlag({ nodeId: "claude:child" })],
    });
    const preflightSpy = vi
      .spyOn(api, "preflight")
      .mockImplementation(async (nodeId: string) => makePreflight(nodeId));

    render(<Inspector node={flagged} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /restore to before this node/i }));
    await waitFor(() => expect(preflightSpy).toHaveBeenCalledWith("claude:parent"));
    expect(preflightSpy).not.toHaveBeenCalledWith("claude:child");
  });

  it("falls back to the node itself when parentId is null", async () => {
    const flagged = makeNode("claude:root", {
      kind: "assistant",
      parentId: null,
      flags: [makeStoredFlag({ nodeId: "claude:root" })],
    });
    const preflightSpy = vi
      .spyOn(api, "preflight")
      .mockImplementation(async (nodeId: string) => makePreflight(nodeId));

    render(<Inspector node={flagged} onFlagDismissed={() => {}} onAnnotationAdded={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /restore to before this node/i }));
    await waitFor(() => expect(preflightSpy).toHaveBeenCalledWith("claude:root"));
  });
});
