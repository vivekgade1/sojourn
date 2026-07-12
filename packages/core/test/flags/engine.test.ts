import { describe, it, expect, vi } from "vitest";
import { FlagEngine, allT1Checks, autoResolveFlags } from "../../src/flags/engine.js";
import type { ChronoNode, Flag, FlagKind, StoredFlag } from "../../src/types.js";
import type { CheckContext, FlagCheck, FetchJson } from "../../src/interfaces.js";

let counter = 0;
function makeNode(overrides: Partial<ChronoNode> = {}): ChronoNode {
  counter += 1;
  return {
    id: `claude:node-${counter}`,
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: new Date().toISOString(),
    snapshotRef: "deadbeef",
    label: null,
    summary: "",
    content: "done",
    meta: { nativeUuid: `node-${counter}` },
    ...overrides,
  };
}

function makeCtx(node: ChronoNode, overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    node,
    priorNodes: [node],
    diff: [],
    parentTree: "parent-tree",
    nodeTree: "node-tree",
    projectRoot: "/tmp/project",
    snapshotter: null,
    fetchJson: (async () => ({ status: 200, body: {} })) as FetchJson,
    ...overrides,
  };
}

function makeFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence: "high",
    evidence: "claimed edit to `auth.py`; snapshot diff shows no change to that file",
    source: "deterministic",
    ...overrides,
  };
}

describe("FlagEngine.runOnNode", () => {
  it("concatenates flags from all applicable checks", async () => {
    const checkA: FlagCheck = {
      kind: "edit_claim_mismatch",
      appliesTo: () => true,
      run: async () => [makeFlag({ kind: "edit_claim_mismatch", evidence: "from A" })],
    };
    const checkB: FlagCheck = {
      kind: "file_ref_missing",
      appliesTo: () => true,
      run: async () => [makeFlag({ kind: "file_ref_missing", evidence: "from B" })],
    };
    const engine = new FlagEngine([checkA, checkB]);
    const node = makeNode();
    const flags = await engine.runOnNode(makeCtx(node));
    expect(flags).toHaveLength(2);
    expect(flags.map((f) => f.evidence).sort()).toEqual(["from A", "from B"]);
  });

  it("gates checks by appliesTo — skips checks that don't apply to this node", async () => {
    const applies: FlagCheck = {
      kind: "edit_claim_mismatch",
      appliesTo: (n) => n.kind === "assistant",
      run: async () => [makeFlag({ evidence: "should run" })],
    };
    const doesNotApply: FlagCheck = {
      kind: "file_ref_missing",
      appliesTo: (n) => n.kind === "tool_use",
      run: async () => [makeFlag({ kind: "file_ref_missing", evidence: "should NOT run" })],
    };
    const engine = new FlagEngine([applies, doesNotApply]);
    const node = makeNode({ kind: "assistant" });
    const flags = await engine.runOnNode(makeCtx(node));
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toBe("should run");
  });

  it("defaults to allT1Checks() when constructed with no argument", () => {
    const engine = new FlagEngine();
    // Indirect check: default engine should run without throwing on a
    // no-claim assistant node and produce no flags (precision-first: a
    // clean node shows zero flags).
    return engine.runOnNode(makeCtx(makeNode({ content: "Hello, how can I help?" }))).then((flags) => {
      expect(flags).toEqual([]);
    });
  });
});

describe("allT1Checks", () => {
  it("returns the five T1 deterministic checks", () => {
    const checks = allT1Checks();
    const kinds = checks.map((c) => c.kind).sort();
    expect(kinds).toEqual(
      [
        "edit_claim_mismatch",
        "file_ref_missing",
        "package_hallucination",
        "symbol_not_found",
        "test_claim_unverified",
      ].sort(),
    );
  });
});

interface FakeStore {
  flagsByNode: Map<string, StoredFlag[]>;
  sessionNodes: ChronoNode[];
  resolved: number[];
}

function makeFakeStore(flagsByNode: Map<string, StoredFlag[]>, sessionNodes: ChronoNode[]): FakeStore & {
  getFlags(nodeId: string): StoredFlag[];
  resolveFlag(id: number): void;
  getSessionNodes(sessionId: string): ChronoNode[];
} {
  const resolved: number[] = [];
  return {
    flagsByNode,
    sessionNodes,
    resolved,
    getFlags(nodeId: string) {
      return flagsByNode.get(nodeId) ?? [];
    },
    resolveFlag(id: number) {
      resolved.push(id);
    },
    getSessionNodes() {
      return sessionNodes;
    },
  };
}

describe("autoResolveFlags", () => {
  it("resolves a flag on an earlier node once a later node's diff shows the claimed file was actually touched", async () => {
    const nodeA = makeNode({ content: "I updated `auth.py` to handle refresh tokens." });
    const storedFlag: StoredFlag = {
      ...makeFlag({ kind: "edit_claim_mismatch" }),
      id: 42,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    const nodeB = makeNode({ content: "Following up on the previous change." });

    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [storedFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    // At node B, the diff (parentTree(A) -> nodeTree(B), or however the
    // caller frames it) now shows auth.py as changed, so the original
    // edit_claim_mismatch on node A should no longer hold.
    const ctxB = makeCtx(nodeB, { diff: [{ path: "auth.py", status: "M" }] });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(1);
    expect(store.resolved).toEqual([42]);
  });

  it("does not resolve a flag when the condition still holds", async () => {
    const nodeA = makeNode({ content: "I updated `auth.py` to handle refresh tokens." });
    const storedFlag: StoredFlag = {
      ...makeFlag({ kind: "edit_claim_mismatch" }),
      id: 7,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    const nodeB = makeNode({ content: "Still working on it." });
    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [storedFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    const ctxB = makeCtx(nodeB, { diff: [{ path: "other.py", status: "M" }] });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(0);
    expect(store.resolved).toEqual([]);
  });

  it("resolves only the claim that was fixed when one node produced TWO edit_claim_mismatch flags and only one is later fixed", async () => {
    const nodeA = makeNode({
      content: "I updated `auth.py` to handle refresh tokens and updated `billing.py` for the new plan.",
    });
    const storedFlagAuth: StoredFlag = {
      ...makeFlag({
        kind: "edit_claim_mismatch",
        evidence: "claimed edit to `auth.py`; snapshot diff shows no change to that file",
      }),
      id: 101,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    const storedFlagBilling: StoredFlag = {
      ...makeFlag({
        kind: "edit_claim_mismatch",
        evidence: "claimed edit to `billing.py`; snapshot diff shows no change to that file",
      }),
      id: 102,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    const nodeB = makeNode({ content: "Following up on the previous change." });

    const flagsByNode = new Map<string, StoredFlag[]>([
      [nodeA.id, [storedFlagAuth, storedFlagBilling]],
    ]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    // Only auth.py shows up as changed in the later diff; billing.py's claim
    // is still unfixed.
    const ctxB = makeCtx(nodeB, { diff: [{ path: "auth.py", status: "M" }] });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(1);
    expect(store.resolved).toEqual([101]);
  });

  it("resolves only the file-A symbol_not_found flag when the same symbol is still missing in file B", async () => {
    const nodeA = makeNode({
      content:
        "I called `helperA()` in `src/a.ts`. I also called `helperA()` in `src/b.ts`.",
    });
    const storedFlagA: StoredFlag = {
      ...makeFlag({
        kind: "symbol_not_found",
        evidence:
          "claimed symbol `helperA` in `src/a.ts`; that file's content has no occurrence of `helperA`",
      }),
      id: 201,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    const storedFlagB: StoredFlag = {
      ...makeFlag({
        kind: "symbol_not_found",
        evidence:
          "claimed symbol `helperA` in `src/b.ts`; that file's content has no occurrence of `helperA`",
      }),
      id: 202,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    const nodeB = makeNode({ content: "Following up on the previous change." });

    const flagsByNode = new Map<string, StoredFlag[]>([
      [nodeA.id, [storedFlagA, storedFlagB]],
    ]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    // autoResolveFlags re-runs the real symbolsCheck (kind "symbol_not_found")
    // for nodeA's claim text, but against the ground truth available at
    // nodeB (i.e. this ctx's snapshotter). The symbol now exists in file A's
    // content but is still missing in file B's content.
    const fileContents: Record<string, string> = {
      "src/a.ts": "export function helperA() {}",
      "src/b.ts": "export function other() {}",
    };
    const snapshotter = {
      readFile: async (_tree: string, path: string) => fileContents[path] ?? null,
    };
    const ctxB = makeCtx(nodeB, {
      snapshotter: snapshotter as unknown as CheckContext["snapshotter"],
      nodeTree: "node-tree-b",
    });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(1);
    expect(store.resolved).toEqual([201]);
  });

  it("does not attempt to resolve flags that are already dismissed", async () => {
    const nodeA = makeNode({ content: "I updated `auth.py` to handle refresh tokens." });
    const storedFlag: StoredFlag = {
      ...makeFlag({ kind: "edit_claim_mismatch" }),
      id: 99,
      nodeId: nodeA.id,
      dismissed: true,
      createdAt: new Date().toISOString(),
    };
    const nodeB = makeNode({ content: "Following up." });
    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [storedFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    const ctxB = makeCtx(nodeB, { diff: [{ path: "auth.py", status: "M" }] });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(0);
    expect(store.resolved).toEqual([]);
  });
});

describe("autoResolveFlags digest (suppressedCount > 0) group semantics", () => {
  // A digest flag's evidence names only the SAMPLE claim; the other
  // suppressed claims' evidence was never persisted. Per-claim matching
  // therefore CANNOT be used to decide whether a digest still holds — it
  // must resolve only when its whole kind+tier group clears at re-eval.

  it("does NOT resolve a digest when only the sample claim is fixed but a sibling suppressed claim still reproduces", async () => {
    // Node A claimed edits to BOTH auth.py and billing.py; budgets kept the
    // auth.py flag as the digest's sample and suppressed the rest.
    const nodeA = makeNode({
      content:
        "I updated `auth.py` to handle refresh tokens and updated `billing.py` for the new plan.",
    });
    const digestFlag: StoredFlag = {
      ...makeFlag({
        kind: "edit_claim_mismatch",
        evidence:
          "claimed edit to `auth.py`; snapshot diff shows no change to that file …and similar claims suppressed",
      }),
      id: 701,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
      suppressedCount: 4,
    };
    const nodeB = makeNode({ content: "Following up." });
    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [digestFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    // Later diff fixes ONLY the sample (auth.py). billing.py's claim still
    // reproduces at re-eval, so the group has NOT cleared: the digest must
    // stay active — resolving it would silently eat the suppressed true
    // positives it stands in for.
    const ctxB = makeCtx(nodeB, { diff: [{ path: "auth.py", status: "M" }] });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(0);
    expect(store.resolved).toEqual([]);
  });

  it("DOES resolve a digest once the entire kind+tier group clears at re-evaluation", async () => {
    const nodeA = makeNode({
      content:
        "I updated `auth.py` to handle refresh tokens and updated `billing.py` for the new plan.",
    });
    const digestFlag: StoredFlag = {
      ...makeFlag({
        kind: "edit_claim_mismatch",
        evidence:
          "claimed edit to `auth.py`; snapshot diff shows no change to that file …and similar claims suppressed",
      }),
      id: 702,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
      suppressedCount: 4,
    };
    const nodeB = makeNode({ content: "Following up." });
    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [digestFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    // Every claimed file now shows up in the diff: the re-run check produces
    // no edit_claim_mismatch flag at all, so the group cleared.
    const ctxB = makeCtx(nodeB, {
      diff: [
        { path: "auth.py", status: "M" },
        { path: "billing.py", status: "M" },
      ],
    });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(1);
    expect(store.resolved).toEqual([702]);
  });

  it("still resolves an ORDINARY flag per-claim on the same node while a digest sibling stays held by the group", async () => {
    // One node carries BOTH an ordinary flag (auth.py) and a digest whose
    // sample is billing.py. The later diff fixes auth.py only: the ordinary
    // flag resolves per-claim; the digest stays (its group still reproduces).
    const nodeA = makeNode({
      content:
        "I updated `auth.py` to handle refresh tokens and updated `billing.py` for the new plan.",
    });
    const ordinaryFlag: StoredFlag = {
      ...makeFlag({
        kind: "edit_claim_mismatch",
        evidence: "claimed edit to `auth.py`; snapshot diff shows no change to that file",
      }),
      id: 703,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    const digestFlag: StoredFlag = {
      ...makeFlag({
        kind: "edit_claim_mismatch",
        evidence:
          "claimed edit to `billing.py`; snapshot diff shows no change to that file …and similar claims suppressed",
      }),
      id: 704,
      nodeId: nodeA.id,
      dismissed: false,
      createdAt: new Date().toISOString(),
      suppressedCount: 3,
    };
    const nodeB = makeNode({ content: "Following up." });
    const flagsByNode = new Map<string, StoredFlag[]>([
      [nodeA.id, [ordinaryFlag, digestFlag]],
    ]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    const ctxB = makeCtx(nodeB, { diff: [{ path: "auth.py", status: "M" }] });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(1);
    expect(store.resolved).toEqual([703]);
  });
});

describe("autoResolveFlags with turnBaseOf (span re-evaluation)", () => {
  const BASE_OLD = "base-old-turn";
  const BASE_CURRENT = "base-current-turn";
  const TREE_CURRENT = "tree-current";

  function makeStoredFlag(nodeId: string, id: number, overrides: Partial<Flag> = {}): StoredFlag {
    return {
      ...makeFlag(overrides),
      id,
      nodeId,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
  }

  it("does NOT auto-resolve a package flag when a later turn only touches an unrelated file (span diff still shows the bogus import)", async () => {
    // Turn 4: node A introduced `import totallybogus` in src/deps.py — flagged.
    const nodeA = makeNode({ content: "Added `src/deps.py` with the imports we need." });
    const storedFlag = makeStoredFlag(nodeA.id, 301, {
      kind: "package_hallucination",
      evidence:
        "claimed/used import of package `totallybogus`; PyPI returned 404 (not found) for that package name",
    });
    // Turn 10: current node's own diff only contains src/auth.py.
    const nodeCurrent = makeNode({ content: "Refactored `src/auth.py` for clarity." });

    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [storedFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeCurrent]);

    const diffSpy = vi.fn(async (treeA: string | null, _treeB: string) => {
      if (treeA === BASE_OLD) {
        // Span diff (node A's turn base -> current tree) still covers deps.py.
        return [
          { path: "src/deps.py", status: "A" as const },
          { path: "src/auth.py", status: "M" as const },
        ];
      }
      return [{ path: "src/auth.py", status: "M" as const }];
    });
    const snapshotter = {
      diff: diffSpy,
      readFile: async (_tree: string, path: string) =>
        path === "src/deps.py" ? "import totallybogus\n" : null,
      listFiles: async () => ["src/deps.py", "src/auth.py"],
    };
    const fetchJson: FetchJson = async () => ({ status: 404, body: {} });

    const ctx = makeCtx(nodeCurrent, {
      priorNodes: [nodeA, nodeCurrent],
      diff: [{ path: "src/auth.py", status: "M" }],
      parentTree: BASE_CURRENT,
      nodeTree: TREE_CURRENT,
      snapshotter: snapshotter as unknown as CheckContext["snapshotter"],
      fetchJson,
    });

    const count = await autoResolveFlags(store, nodeCurrent, ctx, undefined, (n) =>
      n.id === nodeA.id ? BASE_OLD : BASE_CURRENT,
    );

    expect(count).toBe(0);
    expect(store.resolved).toEqual([]);
  });

  it("DOES auto-resolve a package flag when the bogus import is gone at the current tree", async () => {
    const nodeA = makeNode({ content: "Added `src/deps.py` with the imports we need." });
    const storedFlag = makeStoredFlag(nodeA.id, 302, {
      kind: "package_hallucination",
      evidence:
        "claimed/used import of package `totallybogus`; PyPI returned 404 (not found) for that package name",
    });
    const nodeCurrent = makeNode({ content: "Refactored `src/auth.py` for clarity." });

    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [storedFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeCurrent]);

    const snapshotter = {
      diff: async (treeA: string | null, _treeB: string) =>
        treeA === BASE_OLD
          ? [
              { path: "src/deps.py", status: "A" as const },
              { path: "src/auth.py", status: "M" as const },
            ]
          : [{ path: "src/auth.py", status: "M" as const }],
      // The import was removed in an intermediate turn: at the CURRENT tree
      // deps.py no longer contains the bogus import.
      readFile: async (_tree: string, path: string) =>
        path === "src/deps.py" ? "import os\n" : null,
      listFiles: async () => ["src/deps.py", "src/auth.py"],
    };
    const fetchJson: FetchJson = async () => ({ status: 404, body: {} });

    const ctx = makeCtx(nodeCurrent, {
      priorNodes: [nodeA, nodeCurrent],
      diff: [{ path: "src/auth.py", status: "M" }],
      parentTree: BASE_CURRENT,
      nodeTree: TREE_CURRENT,
      snapshotter: snapshotter as unknown as CheckContext["snapshotter"],
      fetchJson,
    });

    const count = await autoResolveFlags(store, nodeCurrent, ctx, undefined, (n) =>
      n.id === nodeA.id ? BASE_OLD : BASE_CURRENT,
    );

    expect(count).toBe(1);
    expect(store.resolved).toEqual([302]);
  });

  it("resolves an edit claim fixed TWO turns earlier even though the current turn's own diff misses the file", async () => {
    const nodeA = makeNode({ content: "I updated `src/x.py` to fix the parser." });
    const storedFlag = makeStoredFlag(nodeA.id, 303, {
      kind: "edit_claim_mismatch",
      evidence: "claimed edit to `src/x.py`; snapshot diff shows no change to that file",
    });
    const nodeCurrent = makeNode({ content: "Unrelated follow-up." });

    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [storedFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeCurrent]);

    const snapshotter = {
      // Span diff (baseOld -> current) includes x.py, fixed in turn 8;
      // the CURRENT turn's own diff (below) does not.
      diff: async (treeA: string | null, _treeB: string) =>
        treeA === BASE_OLD
          ? [
              { path: "src/x.py", status: "M" as const },
              { path: "src/other.py", status: "M" as const },
            ]
          : [{ path: "src/other.py", status: "M" as const }],
    };

    const ctx = makeCtx(nodeCurrent, {
      priorNodes: [nodeA, nodeCurrent],
      diff: [{ path: "src/other.py", status: "M" }],
      parentTree: BASE_CURRENT,
      nodeTree: TREE_CURRENT,
      snapshotter: snapshotter as unknown as CheckContext["snapshotter"],
    });

    const count = await autoResolveFlags(store, nodeCurrent, ctx, undefined, (n) =>
      n.id === nodeA.id ? BASE_OLD : BASE_CURRENT,
    );

    expect(count).toBe(1);
    expect(store.resolved).toEqual([303]);
  });

  it("caches the span diff by base value across flags sharing a turn base, and reuses ctx.diff when the base equals ctx.parentTree", async () => {
    const nodeA = makeNode({ content: "I updated `src/x.py` to fix the parser." });
    const nodeB = makeNode({ content: "I updated `src/y.py` for the new schema." });
    // Node C shares the CURRENT turn base — its span diff is just ctx.diff.
    const nodeC = makeNode({ content: "I updated `src/z.py` as well." });
    const flagA = makeStoredFlag(nodeA.id, 401, {
      kind: "edit_claim_mismatch",
      evidence: "claimed edit to `src/x.py`; snapshot diff shows no change to that file",
    });
    const flagB = makeStoredFlag(nodeB.id, 402, {
      kind: "edit_claim_mismatch",
      evidence: "claimed edit to `src/y.py`; snapshot diff shows no change to that file",
    });
    const flagC = makeStoredFlag(nodeC.id, 403, {
      kind: "edit_claim_mismatch",
      evidence: "claimed edit to `src/z.py`; snapshot diff shows no change to that file",
    });
    const nodeCurrent = makeNode({ content: "Unrelated follow-up." });

    const flagsByNode = new Map<string, StoredFlag[]>([
      [nodeA.id, [flagA]],
      [nodeB.id, [flagB]],
      [nodeC.id, [flagC]],
    ]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB, nodeC, nodeCurrent]);

    const diffSpy = vi.fn(async (_treeA: string | null, _treeB: string) => [
      { path: "src/x.py", status: "M" as const },
      { path: "src/y.py", status: "M" as const },
    ]);
    const snapshotter = { diff: diffSpy };

    const ctx = makeCtx(nodeCurrent, {
      priorNodes: [nodeA, nodeB, nodeC, nodeCurrent],
      diff: [{ path: "src/z.py", status: "M" }],
      parentTree: BASE_CURRENT,
      nodeTree: TREE_CURRENT,
      snapshotter: snapshotter as unknown as CheckContext["snapshotter"],
    });

    const count = await autoResolveFlags(store, nodeCurrent, ctx, undefined, (n) =>
      n.id === nodeC.id ? BASE_CURRENT : BASE_OLD,
    );

    expect(count).toBe(3);
    expect(store.resolved.sort()).toEqual([401, 402, 403]);
    // A and B share BASE_OLD -> one diff call; C's base === ctx.parentTree ->
    // ctx.diff reused, no extra diff call.
    expect(diffSpy).toHaveBeenCalledTimes(1);
    expect(diffSpy).toHaveBeenCalledWith(BASE_OLD, TREE_CURRENT);
  });

  it("fails SOFT when the span diff errors: the flag is kept active and nothing throws", async () => {
    const nodeA = makeNode({ content: "I updated `src/x.py` to fix the parser." });
    const storedFlag = makeStoredFlag(nodeA.id, 501, {
      kind: "edit_claim_mismatch",
      evidence: "claimed edit to `src/x.py`; snapshot diff shows no change to that file",
    });
    const nodeCurrent = makeNode({ content: "Unrelated follow-up." });

    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [storedFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeCurrent]);

    const snapshotter = {
      diff: async () => {
        throw new Error("git object missing");
      },
    };

    const ctx = makeCtx(nodeCurrent, {
      priorNodes: [nodeA, nodeCurrent],
      diff: [{ path: "src/x.py", status: "M" }],
      parentTree: BASE_CURRENT,
      nodeTree: TREE_CURRENT,
      snapshotter: snapshotter as unknown as CheckContext["snapshotter"],
    });

    const count = await autoResolveFlags(store, nodeCurrent, ctx, undefined, () => BASE_OLD);

    expect(count).toBe(0);
    expect(store.resolved).toEqual([]);
  });

  it("preserves old turn-scoped behavior when turnBaseOf is absent (ctx.diff used, no span diff computed)", async () => {
    const nodeA = makeNode({ content: "I updated `auth.py` to handle refresh tokens." });
    const storedFlag = makeStoredFlag(nodeA.id, 601, {
      kind: "edit_claim_mismatch",
      evidence: "claimed edit to `auth.py`; snapshot diff shows no change to that file",
    });
    const nodeB = makeNode({ content: "Following up." });
    const flagsByNode = new Map<string, StoredFlag[]>([[nodeA.id, [storedFlag]]]);
    const store = makeFakeStore(flagsByNode, [nodeA, nodeB]);

    const diffSpy = vi.fn(async () => [] as { path: string; status: "M" }[]);
    const snapshotter = { diff: diffSpy };

    const ctxB = makeCtx(nodeB, {
      diff: [{ path: "auth.py", status: "M" }],
      parentTree: BASE_CURRENT,
      nodeTree: TREE_CURRENT,
      snapshotter: snapshotter as unknown as CheckContext["snapshotter"],
    });

    const count = await autoResolveFlags(store, nodeB, ctxB);
    expect(count).toBe(1);
    expect(store.resolved).toEqual([601]);
    expect(diffSpy).not.toHaveBeenCalled();
  });
});
