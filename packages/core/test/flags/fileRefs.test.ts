import { describe, it, expect } from "vitest";
import { fileRefsCheck } from "../../src/flags/fileRefs.js";
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

function makeSnapshotter(files: string[]): SnapshotterLike {
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
      return files;
    },
    async readFile() {
      return null;
    },
    async restoreToWorktree() {},
  };
}

function makeCtx(
  overrides: Partial<Omit<CheckContext, "snapshotter">> & {
    files?: string[];
    snapshotter?: SnapshotterLike | null;
  },
): CheckContext {
  const node = overrides.node ?? makeNode();
  const files = overrides.files ?? [];
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

describe("fileRefsCheck.appliesTo", () => {
  it("applies only to assistant nodes with string text content", () => {
    expect(fileRefsCheck.appliesTo(makeNode({ kind: "assistant", content: "hi" }))).toBe(true);
    expect(fileRefsCheck.appliesTo(makeNode({ kind: "prompt", content: "hi" }))).toBe(false);
    expect(fileRefsCheck.appliesTo(makeNode({ kind: "assistant", content: {} }))).toBe(false);
  });
});

describe("fileRefsCheck.run — true positive", () => {
  it("flags file_ref_missing medium when a referenced file does not exist and existence is implied", async () => {
    const node = makeNode({ content: "The config is defined in `src/config/settings.ts`, take a look." });
    const ctx = makeCtx({ node, files: ["src/other.ts"] });
    const flags = await fileRefsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("file_ref_missing");
    expect(flags[0].tier).toBe("verified");
    expect(flags[0].source).toBe("deterministic");
    expect(flags[0].confidence).toBe("medium");
    expect(flags[0].evidence).toContain("src/config/settings.ts");
    expect(flags[0].evidence.toLowerCase()).toContain("not");
  });
});

describe("fileRefsCheck.run — true negatives (precision)", () => {
  it("does not flag when the referenced file exists in the tree", async () => {
    const node = makeNode({ content: "See `src/config/settings.ts` for the current values." });
    const ctx = makeCtx({ node, files: ["src/config/settings.ts"] });
    const flags = await fileRefsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when the missing file was just deleted in this node's diff", async () => {
    const node = makeNode({ content: "The file `src/old/legacy.ts` was removed, check it if you need history." });
    const ctx = makeCtx({
      node,
      files: [],
      diff: [{ path: "src/old/legacy.ts", status: "D" }],
    });
    const flags = await fileRefsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag backticked tokens without existence-implying language nearby", async () => {
    const node = makeNode({
      content: "For reference, naming conventions similar to `src/config/settings.ts` are common.",
    });
    const ctx = makeCtx({ node, files: [] });
    const flags = await fileRefsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag URLs, globs, node_modules paths, or tokens without a slash+extension", async () => {
    const node = makeNode({
      content:
        "See `https://example.com/readme.md`, check `src/**/*.ts`, open `node_modules/foo/index.js`, and see `README` for more.",
    });
    const ctx = makeCtx({ node, files: [] });
    const flags = await fileRefsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when nodeTree is null (no ground truth)", async () => {
    const node = makeNode({ content: "The config is defined in `src/config/settings.ts`." });
    const ctx = makeCtx({ node, files: ["src/other.ts"], nodeTree: null });
    const flags = await fileRefsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when snapshotter is null (no ground truth)", async () => {
    const node = makeNode({ content: "The config is defined in `src/config/settings.ts`." });
    const ctx = makeCtx({ node, files: ["src/other.ts"], snapshotter: null });
    const flags = await fileRefsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });
});
