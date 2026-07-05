import { describe, it, expect, vi } from "vitest";
import { packagesCheck } from "../../src/flags/packages.js";
import type { ChronoNode } from "../../src/types.js";
import type { CheckContext, FetchJson, SnapshotterLike } from "../../src/interfaces.js";

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

describe("packagesCheck.appliesTo", () => {
  it("applies only to assistant nodes with string text content", () => {
    expect(packagesCheck.appliesTo(makeNode({ kind: "assistant", content: "hi" }))).toBe(true);
    expect(packagesCheck.appliesTo(makeNode({ kind: "tool_result", content: "hi" }))).toBe(false);
    expect(packagesCheck.appliesTo(makeNode({ kind: "assistant", content: 123 }))).toBe(false);
  });
});

describe("packagesCheck.run — true positive", () => {
  it("flags package_hallucination high for a JS import that 404s on the npm registry", async () => {
    const files: Record<string, string> = {
      "src/index.ts": `import { totallyFakePkg123 } from "totally-fake-pkg-123";\n`,
    };
    const fetchJson: FetchJson = vi.fn(async (url: string) => {
      if (url.includes("totally-fake-pkg-123")) return { status: 404, body: null };
      return { status: 200, body: {} };
    });
    const node = makeNode({ content: "I added a helper using a new package." });
    const ctx = makeCtx({
      node,
      diff: [{ path: "src/index.ts", status: "A" }],
      files,
      fetchJson,
    });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("package_hallucination");
    expect(flags[0].tier).toBe("verified");
    expect(flags[0].source).toBe("deterministic");
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence).toContain("totally-fake-pkg-123");
    expect(flags[0].evidence.toLowerCase()).toMatch(/registry|npm|not found|404/);
  });

  it("flags package_hallucination high for a Python import that 404s on PyPI", async () => {
    const files: Record<string, string> = {
      "script.py": `import definitely_not_a_real_pkg\n`,
    };
    const fetchJson: FetchJson = vi.fn(async (url: string) => {
      if (url.includes("definitely_not_a_real_pkg")) return { status: 404, body: null };
      return { status: 200, body: {} };
    });
    const node = makeNode({ content: "I wrote a script that uses a new library." });
    const ctx = makeCtx({
      node,
      diff: [{ path: "script.py", status: "A" }],
      files,
      fetchJson,
    });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("definitely_not_a_real_pkg");
  });
});

describe("packagesCheck.run — true negatives (precision)", () => {
  it("does not flag when the package exists on the registry (200 status)", async () => {
    const files: Record<string, string> = {
      "src/index.ts": `import { z } from "zod";\n`,
    };
    const fetchJson: FetchJson = vi.fn(async () => ({ status: 200, body: { name: "zod" } }));
    const ctx = makeCtx({ diff: [{ path: "src/index.ts", status: "A" }], files, fetchJson });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag Node builtins, relative imports, or scoped subpaths already in package.json", async () => {
    const files: Record<string, string> = {
      "src/index.ts": [
        `import fs from "fs";`,
        `import fsp from "node:fs/promises";`,
        `import { helper } from "./local-helper.js";`,
        `import { thing } from "@sojourn/core/foo";`,
      ].join("\n"),
      "package.json": JSON.stringify({ dependencies: { "@sojourn/core": "^0.1.0" } }),
    };
    const fetchJson: FetchJson = vi.fn(async () => ({ status: 404, body: null }));
    const ctx = makeCtx({ diff: [{ path: "src/index.ts", status: "M" }], files, fetchJson });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(0);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("does not flag on network error or non-404 error status (fails open)", async () => {
    const files: Record<string, string> = {
      "src/index.ts": `import { thing } from "some-package-name";\n`,
    };
    const fetchJson: FetchJson = vi.fn(async () => {
      throw new Error("network down");
    });
    const ctx = makeCtx({ diff: [{ path: "src/index.ts", status: "A" }], files, fetchJson });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when nodeTree or snapshotter is null (no ground truth)", async () => {
    const files: Record<string, string> = {
      "src/index.ts": `import { thing } from "some-fake-package-xyz";\n`,
    };
    const fetchJson: FetchJson = vi.fn(async () => ({ status: 404, body: null }));
    const ctx1 = makeCtx({ diff: [{ path: "src/index.ts", status: "A" }], files, fetchJson, nodeTree: null });
    expect(await packagesCheck.run(ctx1)).toHaveLength(0);

    const ctx2 = makeCtx({
      diff: [{ path: "src/index.ts", status: "A" }],
      files,
      fetchJson,
      snapshotter: null,
    });
    expect(await packagesCheck.run(ctx2)).toHaveLength(0);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("caches lookups so the same package is only fetched once per run", async () => {
    const files: Record<string, string> = {
      "a.ts": `import { x } from "dupe-package";\n`,
      "b.ts": `import { y } from "dupe-package";\n`,
    };
    const fetchJson: FetchJson = vi.fn(async () => ({ status: 200, body: {} }));
    const ctx = makeCtx({
      diff: [
        { path: "a.ts", status: "A" },
        { path: "b.ts", status: "A" },
      ],
      files,
      fetchJson,
    });
    await packagesCheck.run(ctx);
    const calls = (fetchJson as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("dupe-package"),
    );
    expect(calls).toHaveLength(1);
  });
});
