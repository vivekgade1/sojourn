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
