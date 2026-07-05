import { describe, it, expect } from "vitest";
import { symbolsCheck } from "../../src/flags/symbols.js";
import type { ChronoNode } from "../../src/types.js";
import type { CheckContext, SnapshotterLike, FetchJson } from "../../src/interfaces.js";

function makeNode(overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id: "claude:node-1",
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
    meta: { nativeUuid: "node-1" },
    ...overrides,
  };
}

function makeSnapshotter(files: Record<string, string>): SnapshotterLike {
  return {
    async init() {},
    async snapshot() {
      return "tree";
    },
    async hasTree() {
      return true;
    },
    async diff() {
      return [];
    },
    async diffFile() {
      return "";
    },
    async listFiles() {
      return Object.keys(files);
    },
    async readFile(_tree, p) {
      return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
    },
    async restoreToWorktree() {},
  };
}

function makeCtx(
  overrides: Partial<Omit<CheckContext, "snapshotter">> & {
    files?: Record<string, string>;
    snapshotter?: SnapshotterLike | null;
  },
): CheckContext {
  const node = overrides.node ?? makeNode();
  const files = overrides.files ?? {};
  const snapshotter =
    overrides.snapshotter === undefined ? makeSnapshotter(files) : overrides.snapshotter;
  return {
    node,
    priorNodes: [node],
    diff: [],
    parentTree: "parent-tree",
    nodeTree: "node-tree",
    projectRoot: "/tmp/project",
    fetchJson: (async () => ({ status: 200, body: {} })) as FetchJson,
    ...overrides,
    snapshotter,
  };
}

describe("symbolsCheck.appliesTo", () => {
  it("applies only to assistant nodes with string text content", () => {
    expect(symbolsCheck.appliesTo(makeNode({ kind: "assistant", content: "hi" }))).toBe(true);
    expect(symbolsCheck.appliesTo(makeNode({ kind: "tool_use", content: "hi" }))).toBe(false);
    expect(symbolsCheck.appliesTo(makeNode({ kind: "assistant", content: null }))).toBe(false);
  });
});

describe("symbolsCheck.run — true positive", () => {
  it("flags symbol_not_found high when the named function doesn't appear in the co-referenced file", async () => {
    const node = makeNode({
      content: "I added the function `computeTotal()` in `src/utils.ts` to handle this.",
    });
    const files = { "src/utils.ts": "export function otherFn() { return 1; }\n" };
    const ctx = makeCtx({ node, files });
    const flags = await symbolsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("symbol_not_found");
    expect(flags[0].tier).toBe("verified");
    expect(flags[0].source).toBe("deterministic");
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence).toContain("computeTotal");
    expect(flags[0].evidence).toContain("src/utils.ts");
  });
});

describe("symbolsCheck.run — true negatives (precision)", () => {
  it("does not flag when the symbol does appear in the co-referenced file", async () => {
    const node = makeNode({
      content: "I added the function `computeTotal()` in `src/utils.ts` to handle this.",
    });
    const files = { "src/utils.ts": "export function computeTotal() { return 1; }\n" };
    const ctx = makeCtx({ node, files });
    const flags = await symbolsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when there is no co-referenced file in the same sentence", async () => {
    const node = makeNode({
      content: "The function `computeTotal()` handles the aggregation logic nicely.",
    });
    const files = { "src/utils.ts": "export function otherFn() { return 1; }\n" };
    const ctx = makeCtx({ node, files });
    const flags = await symbolsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when the co-referenced file token does not resolve to an existing file", async () => {
    const node = makeNode({
      content: "I added the method `computeTotal` in `src/missing.ts` for this feature.",
    });
    const files = { "src/utils.ts": "export function otherFn() { return 1; }\n" };
    const ctx = makeCtx({ node, files });
    const flags = await symbolsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when nodeTree or snapshotter is null (no ground truth)", async () => {
    const node = makeNode({
      content: "I added the function `computeTotal()` in `src/utils.ts` to handle this.",
    });
    const files = { "src/utils.ts": "export function otherFn() { return 1; }\n" };
    const ctx1 = makeCtx({ node, files, nodeTree: null });
    expect(await symbolsCheck.run(ctx1)).toHaveLength(0);
    const ctx2 = makeCtx({ node, files, snapshotter: null });
    expect(await symbolsCheck.run(ctx2)).toHaveLength(0);
  });
});
