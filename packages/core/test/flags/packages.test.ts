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

describe("packagesCheck.run — null parentTree (no turn-scoped base): silence over crying wolf", () => {
  // ctx.parentTree === null means there is no ancestor prompt / no snapshot
  // before it, so ctx.diff was built as diff(null, nodeTree) — a whole-tree
  // pseudo-diff where EVERY file in the repo appears as status "A". That is
  // not evidence the assistant touched anything this turn; treating it as
  // candidate evidence risks flagging files from unrelated earlier turns the
  // assistant never mentioned. Design principle 3 (precision over recall)
  // says the check must go silent here, exactly like editClaimCheck already
  // does for a null tree.
  const bogusImportFiles: Record<string, string> = {
    "src/deps.ts": `import { thing } from "totally-bogus-hallucinated-pkg";\n`,
  };
  const wholeTreePseudoDiff = [{ path: "src/deps.ts", status: "A" as const }];

  it("does NOT flag a bogus import when parentTree is null, even though the registry 404s", async () => {
    const fetchJson: FetchJson = vi.fn(async (url: string) => {
      if (url.includes("totally-bogus-hallucinated-pkg")) return { status: 404, body: null };
      return { status: 200, body: {} };
    });
    const ctx = makeCtx({
      diff: wholeTreePseudoDiff,
      files: bogusImportFiles,
      fetchJson,
      parentTree: null,
    });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(0);
    // Silence means never even reaching the registry lookup, not merely
    // discarding a flag it decided to produce.
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("regression guard: the SAME diff/files still flags when parentTree IS grounded (non-null)", async () => {
    const fetchJson: FetchJson = vi.fn(async (url: string) => {
      if (url.includes("totally-bogus-hallucinated-pkg")) return { status: 404, body: null };
      return { status: 200, body: {} };
    });
    const ctx = makeCtx({
      diff: wholeTreePseudoDiff,
      files: bogusImportFiles,
      fetchJson,
      parentTree: "some-grounded-parent-tree",
    });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("package_hallucination");
    expect(flags[0].evidence).toContain("totally-bogus-hallucinated-pkg");
  });
});

describe("packagesCheck.run — monorepo root package.json merging", () => {
  it("does not flag an import declared only in the ROOT package.json of a monorepo (nested pkg, no node_modules on disk)", async () => {
    const files: Record<string, string> = {
      "packages/x/src/index.ts": `import { describe } from "vitest";\n`,
      "packages/x/package.json": JSON.stringify({ name: "@sojourn/x", dependencies: {} }),
      "package.json": JSON.stringify({
        name: "sojourn-monorepo",
        devDependencies: { vitest: "^3.0.0" },
      }),
    };
    // fetchJson would 404 if actually called for "vitest" — it must not be
    // called at all because vitest is a declared root devDependency.
    const fetchJson: FetchJson = vi.fn(async () => ({ status: 404, body: null }));
    const ctx = makeCtx({
      diff: [{ path: "packages/x/src/index.ts", status: "M" }],
      files,
      fetchJson,
      // No node_modules present in this fake tree — projectRoot points
      // somewhere with nothing on disk, so the only way this can pass is by
      // merging the root package.json's devDependencies while walking up
      // from packages/x/src.
      projectRoot: "/tmp/nonexistent-project-root-for-test",
    });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(0);
    expect(fetchJson).not.toHaveBeenCalled();
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

  it("does not flag path-alias / subpath imports (@/, ~/, #) — never registry packages", async () => {
    const files: Record<string, string> = {
      "src/index.ts": [
        `import { util } from "@/lib/utils";`,
        `import { widget } from "~/components/widget";`,
        `import { internal } from "#internal/thing";`,
      ].join("\n"),
    };
    // Would 404 if any alias leaked through to a registry lookup.
    const fetchJson: FetchJson = vi.fn(async () => ({ status: 404, body: null }));
    const ctx = makeCtx({ diff: [{ path: "src/index.ts", status: "M" }], files, fetchJson });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(0);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("does not flag a Python import that resolves to a local module in the tree (m/ dir or m.py)", async () => {
    const files: Record<string, string> = {
      "script.py": `import helpers\nfrom mypackage.sub import thing\n`,
      "helpers.py": "def helper(): pass\n",
      "mypackage/__init__.py": "",
      "mypackage/sub.py": "thing = 1\n",
    };
    // Neither `helpers` nor `mypackage` exists on PyPI in this scenario —
    // the lookup must be skipped entirely, not merely tolerated.
    const fetchJson: FetchJson = vi.fn(async () => ({ status: 404, body: null }));
    const ctx = makeCtx({ diff: [{ path: "script.py", status: "A" }], files, fetchJson });
    const flags = await packagesCheck.run(ctx);
    expect(flags).toHaveLength(0);
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
