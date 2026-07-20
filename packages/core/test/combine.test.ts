import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/store/index.js";
import { findNearestCommonAncestor } from "../src/store/effectiveTree.js";
import { ShadowSnapshotter } from "../src/snapshot/index.js";
import { combine, combinePreflight, SojournCombineError } from "../src/combine/index.js";
import type { CombineDeps } from "../src/combine/index.js";
import type { ChronoNode, Project } from "../src/types.js";

/**
 * Combine works over real git shadow repos in tmpdirs (same approach as
 * harvest.test.ts): the trees the engine merges are genuine snapshots, so
 * `git merge-file`, binary detection and rename expansion are all exercised
 * for real rather than against stubs.
 */
describe("combine engine", () => {
  let projectRoot: string;
  let shadowDir: string;
  let worktreesDir: string;
  let store: GraphStore;
  let project: Project;
  let tempDirs: string[];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function snapshotter(): ShadowSnapshotter {
    return new ShadowSnapshotter({ projectRoot, shadowDir });
  }

  function makeDeps(extra: Partial<CombineDeps> = {}): CombineDeps {
    return {
      store,
      snapshotterFor: () => snapshotter(),
      worktreesDir,
      now: () => new Date("2026-07-19T12:00:00.000Z"),
      ...extra,
    };
  }

  /** Inserts a node, defaulting everything the test doesn't care about. */
  function addNode(over: Partial<ChronoNode> & { id: string }): ChronoNode {
    const node: ChronoNode = {
      parentId: null,
      kind: "assistant",
      cli: "claude",
      sessionId: "s-main",
      projectId: project.id,
      timestamp: "2026-07-19T00:00:00.000Z",
      snapshotRef: null,
      label: null,
      summary: "",
      content: {},
      meta: { nativeUuid: over.id.split(":")[1] ?? over.id },
      ...over,
    };
    store.upsertNode(node);
    return store.getNode(node.id)!;
  }

  /** Empties the project root, then checks `tree` back out into it.
   * `restoreToWorktree` uses `git checkout-index`, which refuses to overwrite
   * existing files — so the wipe is required, not incidental. */
  async function resetProjectTo(tree: string): Promise<void> {
    for (const entry of await fsp.readdir(projectRoot)) {
      await fsp.rm(path.join(projectRoot, entry), { recursive: true, force: true });
    }
    await snapshotter().restoreToWorktree(tree, projectRoot);
  }

  async function writeFiles(files: Record<string, string | Buffer>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(projectRoot, rel);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content);
    }
  }

  /**
   * Builds the canonical three-node fixture: a shared ancestor `root`, then
   * two nodes in DIFFERENT sessions, each carrying its own snapshot of the
   * project after that session's edits.
   */
  async function buildTwoSessions(
    editsA: Record<string, string | Buffer>,
    editsB: Record<string, string | Buffer>,
  ): Promise<{ root: ChronoNode; a: ChronoNode; b: ChronoNode }> {
    const snap = snapshotter();

    await writeFiles({
      "shared.txt": "line1\nline2\nline3\n",
      "src/app.ts": "export const x = 1;\n",
    });
    const baseTree = await snap.snapshot();
    const root = addNode({ id: "claude:root", snapshotRef: baseTree });

    await writeFiles(editsA);
    const treeA = await snap.snapshot();
    const a = addNode({
      id: "claude:node-a",
      parentId: root.id,
      sessionId: "s-alpha",
      snapshotRef: treeA,
    });

    // Reset the working dir to the base state before session B's edits, so B
    // genuinely branches from the common ancestor rather than from A.
    await resetProjectTo(baseTree);
    await writeFiles(editsB);
    const treeB = await snap.snapshot();
    const b = addNode({
      id: "claude:node-b",
      parentId: root.id,
      sessionId: "s-beta",
      snapshotRef: treeB,
    });

    return { root, a, b };
  }

  async function dirContents(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    async function walk(dir: string): Promise<void> {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out[path.relative(root, full)] = await fsp.readFile(full, "utf8");
      }
    }
    await walk(root);
    return out;
  }

  beforeEach(async () => {
    tempDirs = [];
    projectRoot = makeTempDir("sojourn-combine-project-");
    shadowDir = makeTempDir("sojourn-combine-shadow-");
    worktreesDir = makeTempDir("sojourn-combine-worktrees-");
    await snapshotter().init();

    store = new GraphStore(path.join(makeTempDir("sojourn-combine-db-"), "graph.db"));
    project = store.upsertProject(projectRoot, "Combine Fixture");
  });

  afterEach(() => {
    store.close();
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  // ——— merge base ———

  describe("nearest common ancestor", () => {
    it("finds the branch point of two nodes in different sessions", () => {
      const root = addNode({ id: "claude:r" });
      const a = addNode({ id: "claude:a", parentId: root.id, sessionId: "s-alpha" });
      const b = addNode({ id: "claude:b", parentId: root.id, sessionId: "s-beta" });
      expect(findNearestCommonAncestor(store, a, b)?.id).toBe(root.id);
    });

    it("finds the NEAREST ancestor, not merely a shared one", () => {
      const r = addNode({ id: "claude:r" });
      const mid = addNode({ id: "claude:mid", parentId: r.id });
      const a = addNode({ id: "claude:a", parentId: mid.id });
      const b = addNode({ id: "claude:b", parentId: mid.id });
      expect(findNearestCommonAncestor(store, a, b)?.id).toBe("claude:mid");
    });

    it("works within a single session (linear chain)", () => {
      const r = addNode({ id: "claude:r" });
      const mid = addNode({ id: "claude:mid", parentId: r.id });
      const tip = addNode({ id: "claude:tip", parentId: mid.id });
      // ancestor-or-self: mid IS the last shared state
      expect(findNearestCommonAncestor(store, mid, tip)?.id).toBe("claude:mid");
      expect(findNearestCommonAncestor(store, tip, mid)?.id).toBe("claude:mid");
    });

    it("returns the node itself when both sides are the same node", () => {
      const n = addNode({ id: "claude:solo" });
      expect(findNearestCommonAncestor(store, n, n)?.id).toBe("claude:solo");
    });

    it("returns null when the two nodes have separate roots", () => {
      const a = addNode({ id: "claude:a" });
      const b = addNode({ id: "claude:b" });
      expect(findNearestCommonAncestor(store, a, b)).toBeNull();
    });

    it("terminates on a cyclic parent chain instead of spinning", () => {
      addNode({ id: "claude:c1", parentId: "claude:c2" });
      addNode({ id: "claude:c2", parentId: "claude:c1" });
      const lone = addNode({ id: "claude:lone" });
      const c1 = store.getNode("claude:c1")!;
      // no common ancestor, and crucially: it RETURNS
      expect(findNearestCommonAncestor(store, c1, lone)).toBeNull();
      // a cycle still self-matches without hanging
      expect(findNearestCommonAncestor(store, c1, c1)?.id).toBe("claude:c1");
    });
  });

  // ——— clean merges ———

  it("cleanly merges disjoint edits made in two different sessions", async () => {
    const { root, a, b } = await buildTwoSessions(
      { "a-only.txt": "from session A\n" },
      { "b-only.txt": "from session B\n" },
    );

    const pre = await combinePreflight(makeDeps(), a.id, b.id);
    expect(pre.baseNodeId).toBe(root.id);
    expect(pre.files).toEqual([{ path: "b-only.txt", status: "clean" }]);

    const result = await combine(makeDeps(), a.id, b.id);
    expect(result.applied).toEqual(["b-only.txt"]);
    expect(result.conflicted).toEqual([]);

    const contents = await dirContents(result.worktreePath);
    // A's whole tree is the starting point; B's addition merged on top
    expect(contents["a-only.txt"]).toBe("from session A\n");
    expect(contents["b-only.txt"]).toBe("from session B\n");
    expect(contents["shared.txt"]).toBe("line1\nline2\nline3\n");
  });

  it("three-way merges non-overlapping edits to the SAME file", async () => {
    const { a, b } = await buildTwoSessions(
      { "shared.txt": "line1 CHANGED BY A\nline2\nline3\n" },
      { "shared.txt": "line1\nline2\nline3 CHANGED BY B\n" },
    );

    const result = await combine(makeDeps(), a.id, b.id);
    expect(result.conflicted).toEqual([]);
    expect(result.applied).toEqual(["shared.txt"]);

    const merged = await fsp.readFile(path.join(result.worktreePath, "shared.txt"), "utf8");
    expect(merged).toBe("line1 CHANGED BY A\nline2\nline3 CHANGED BY B\n");
  });

  it("classifies byte-identical edits on both sides as identical, not conflict", async () => {
    const { a, b } = await buildTwoSessions(
      { "shared.txt": "same new content\n" },
      { "shared.txt": "same new content\n" },
    );

    const pre = await combinePreflight(makeDeps(), a.id, b.id);
    expect(pre.files).toEqual([{ path: "shared.txt", status: "identical" }]);

    const result = await combine(makeDeps(), a.id, b.id);
    expect(result.skippedIdentical).toEqual(["shared.txt"]);
    expect(result.applied).toEqual([]);
    expect(result.conflicted).toEqual([]);
    expect(
      await fsp.readFile(path.join(result.worktreePath, "shared.txt"), "utf8"),
    ).toBe("same new content\n");
  });

  // ——— conflicts ———

  describe("conflicting edits to the same lines", () => {
    async function conflictFixture() {
      return buildTwoSessions(
        { "shared.txt": "line1 A WINS\nline2\nline3\n" },
        { "shared.txt": "line1 B WINS\nline2\nline3\n" },
      );
    }

    it("aborts CLEAN by default — no worktree is created at all", async () => {
      const { a, b } = await conflictFixture();

      const pre = await combinePreflight(makeDeps(), a.id, b.id);
      expect(pre.files).toEqual([{ path: "shared.txt", status: "conflict" }]);

      const before = await fsp.readdir(worktreesDir);

      const err = await combine(makeDeps(), a.id, b.id).catch((e) => e);
      expect(err).toBeInstanceOf(SojournCombineError);
      expect((err as SojournCombineError).code).toBe("conflicts");
      expect((err as SojournCombineError).files).toEqual(["shared.txt"]);
      expect((err as SojournCombineError).partial).toBeNull();

      // provably zero-write: the worktrees dir is byte-for-byte unchanged,
      // no project-scoped subdirectory was even created
      expect(await fsp.readdir(worktreesDir)).toEqual(before);
      // and no combine node was recorded
      expect(store.getGraph(project.id).some((n) => n.meta.mergedFrom)).toBe(false);
    });

    it("succeeds with allowConflicts, writing conflict markers", async () => {
      const { a, b } = await conflictFixture();

      const result = await combine(makeDeps(), a.id, b.id, { allowConflicts: true });
      expect(result.conflicted).toEqual(["shared.txt"]);
      expect(result.applied).toEqual([]);

      const merged = await fsp.readFile(path.join(result.worktreePath, "shared.txt"), "utf8");
      expect(merged).toContain("<<<<<<< node A");
      expect(merged).toContain("line1 A WINS");
      expect(merged).toContain("=======");
      expect(merged).toContain("line1 B WINS");
      expect(merged).toContain(">>>>>>> node B");
    });
  });

  it("reports a binary conflict without touching the file (markers impossible)", async () => {
    // NUL byte in the first 8000 bytes => binary by git's own heuristic
    const bin = (byte: number): Buffer => Buffer.from([0x00, 0x01, byte, 0xff]);
    const { a, b } = await buildTwoSessions(
      { "asset.bin": bin(0xaa) },
      { "asset.bin": bin(0xbb) },
    );

    const pre = await combinePreflight(makeDeps(), a.id, b.id);
    expect(pre.files).toEqual([{ path: "asset.bin", status: "conflict", unmarkable: true }]);

    const result = await combine(makeDeps(), a.id, b.id, { allowConflicts: true });
    expect(result.unmarkable).toEqual(["asset.bin"]);
    expect(result.conflicted).toEqual(["asset.bin"]);
    // A's bytes survive verbatim — never markered, never merged
    const onDisk = await fsp.readFile(path.join(result.worktreePath, "asset.bin"));
    expect(onDisk.equals(bin(0xaa))).toBe(true);
    expect(result.warnings.some((w) => w.includes("cannot take text conflict markers"))).toBe(
      true,
    );
  });

  it("applies a deletion made only on side B", async () => {
    const { a, b } = await buildTwoSessions(
      { "a-only.txt": "from A\n" },
      { "shared.txt": "" }, // placeholder; removed below
    );
    // rebuild B as a pure deletion of shared.txt
    await resetProjectTo(store.getNode("claude:root")!.snapshotRef!);
    await fsp.rm(path.join(projectRoot, "shared.txt"), { force: true });
    store.setSnapshotRef(b.id, await snapshotter().snapshot());

    const result = await combine(makeDeps(), a.id, store.getNode(b.id)!.id);
    expect(result.applied).toEqual(["shared.txt"]);
    expect(fs.existsSync(path.join(result.worktreePath, "shared.txt"))).toBe(false);
    expect(fs.existsSync(path.join(result.worktreePath, "a-only.txt"))).toBe(true);
  });

  // ——— refusals ———

  it("refuses two nodes from different projects", async () => {
    const otherRoot = makeTempDir("sojourn-combine-other-");
    const other = store.upsertProject(otherRoot, "Other");
    const a = addNode({ id: "claude:a", snapshotRef: "deadbeef" });
    addNode({ id: "claude:b", projectId: other.id, snapshotRef: "deadbeef" });

    const err = await combine(makeDeps(), a.id, "claude:b").catch((e) => e);
    expect(err).toBeInstanceOf(SojournCombineError);
    expect((err as SojournCombineError).code).toBe("cross_project");
    expect(await fsp.readdir(worktreesDir)).toEqual([]);
  });

  it("refuses nodes with no common ancestor", async () => {
    const a = addNode({ id: "claude:a", snapshotRef: "deadbeef" });
    const b = addNode({ id: "claude:b", snapshotRef: "deadbeef" });

    const err = await combine(makeDeps(), a.id, b.id).catch((e) => e);
    expect((err as SojournCombineError).code).toBe("no_common_ancestor");
    expect(await fsp.readdir(worktreesDir)).toEqual([]);
  });

  it("refuses an unknown node id", async () => {
    const a = addNode({ id: "claude:a" });
    const err = await combine(makeDeps(), a.id, "claude:nope").catch((e) => e);
    expect((err as SojournCombineError).code).toBe("not_found");
  });

  it("refuses when a side has no effective tree", async () => {
    const root = addNode({ id: "claude:root" }); // no snapshotRef anywhere
    const a = addNode({ id: "claude:a", parentId: root.id });
    const b = addNode({ id: "claude:b", parentId: root.id });

    const err = await combine(makeDeps(), a.id, b.id).catch((e) => e);
    expect((err as SojournCombineError).code).toBe("no_tree");
    expect(await fsp.readdir(worktreesDir)).toEqual([]);
  });

  // ——— graph + manifest closure ———

  it("records a combine node parented to A with meta.mergedFrom = B", async () => {
    const { a, b } = await buildTwoSessions(
      { "a-only.txt": "from A\n" },
      { "b-only.txt": "from B\n" },
    );

    const result = await combine(makeDeps(), a.id, b.id);
    expect(result.combineNodeId).not.toBeNull();

    const node = store.getNode(result.combineNodeId!)!;
    expect(node.kind).toBe("checkpoint");
    expect(node.parentId).toBe(a.id);
    expect(node.meta.mergedFrom).toBe(b.id);
    expect(node.sessionId).toBe(a.sessionId);
    expect(node.projectId).toBe(a.projectId);
    expect(node.snapshotRef).toBeNull();
    // provenance only — the graph is still a tree, B is not a second parent
    expect(store.getChildren(b.id)).toEqual([]);
  });

  it("does not record a combine node when nothing was written", async () => {
    const { a, b } = await buildTwoSessions(
      { "shared.txt": "identical\n" },
      { "shared.txt": "identical\n" },
    );
    const result = await combine(makeDeps(), a.id, b.id);
    expect(result.applied).toEqual([]);
    expect(result.combineNodeId).toBeNull();
  });

  it("writes a .sojourn-restore.json that still parses as { nodeId: A }", async () => {
    const { root, a, b } = await buildTwoSessions(
      { "a-only.txt": "from A\n" },
      { "b-only.txt": "from B\n" },
    );

    const result = await combine(makeDeps(), a.id, b.id);
    const raw = await fsp.readFile(
      path.join(result.worktreePath, ".sojourn-restore.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // THE contract the daemon's readRestoreManifest depends on
    expect(typeof parsed.nodeId).toBe("string");
    expect(parsed.nodeId).toBe(a.id);
    expect((parsed.nodeId as string).length).toBeGreaterThan(0);

    // extra provenance keys are additive and must not disturb that
    expect(parsed.combinedWith).toBe(b.id);
    expect(parsed.baseNodeId).toBe(root.id);
  });

  it("names the output worktree distinctly under the project's worktrees dir", async () => {
    const { a, b } = await buildTwoSessions(
      { "a-only.txt": "from A\n" },
      { "b-only.txt": "from B\n" },
    );
    const result = await combine(makeDeps(), a.id, b.id);

    // <worktreesDir>/<projectId>/combine-<a8>-<b8>-<timestamp>
    expect(path.dirname(result.worktreePath)).toBe(path.join(worktreesDir, project.id));
    // 8 alnum chars of each node id: "claude:node-a" -> "claudeno"
    expect(path.basename(result.worktreePath)).toMatch(
      /^combine-claudeno-claudeno-\d{14}$/,
    );
  });

  it("gives two combines of the same pair distinct directories", async () => {
    const { a, b } = await buildTwoSessions(
      { "a-only.txt": "from A\n" },
      { "b-only.txt": "from B\n" },
    );
    const first = await combine(makeDeps(), a.id, b.id);
    const second = await combine(makeDeps(), a.id, b.id);
    expect(second.worktreePath).not.toBe(first.worktreePath);
  });

  // ——— preflight purity ———

  it("preflight writes nothing: no worktree, no snapshot, no graph node", async () => {
    const { a, b } = await buildTwoSessions(
      { "a-only.txt": "from A\n" },
      { "b-only.txt": "from B\n" },
    );

    const projectBefore = await dirContents(projectRoot);
    const graphBefore = store.getGraph(project.id).map((n) => n.id).sort();

    const pre = await combinePreflight(makeDeps(), a.id, b.id);
    expect(pre.files.length).toBeGreaterThan(0);

    expect(await dirContents(projectRoot)).toEqual(projectBefore);
    expect(await fsp.readdir(worktreesDir)).toEqual([]);
    expect(store.getGraph(project.id).map((n) => n.id).sort()).toEqual(graphBefore);
  });
});
