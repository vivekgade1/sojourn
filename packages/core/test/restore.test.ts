import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/store/index.js";
import { ShadowSnapshotter } from "../src/snapshot/index.js";
import { RestoreEngine, SojournRestoreError } from "../src/restore/index.js";
import type { ChronoNode, Project } from "../src/types.js";

function makeNode(overrides: Partial<ChronoNode> = {}): ChronoNode {
  const nativeUuid = overrides.meta?.nativeUuid ?? "uuid-1";
  const cli = overrides.cli ?? "claude";
  return {
    id: `${cli}:${nativeUuid}`,
    parentId: null,
    kind: "prompt",
    cli,
    sessionId: "session-1",
    projectId: "project-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: "a summary",
    content: { text: "hello" },
    meta: { nativeUuid },
    ...overrides,
  };
}

describe("RestoreEngine", () => {
  let projectRoot: string;
  let shadowDir: string;
  let worktreesDir: string;
  let store: GraphStore;
  let snapshotter: ShadowSnapshotter;
  let project: Project;
  let engine: RestoreEngine;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-project-"));
    shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-shadow-"));
    worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-worktrees-"));

    store = new GraphStore(":memory:");
    snapshotter = new ShadowSnapshotter({ projectRoot, shadowDir });
    await snapshotter.init();

    project = store.upsertProject(projectRoot, "Test Project");

    engine = new RestoreEngine({
      store,
      snapshotterFor: () => snapshotter,
      worktreesDir,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(shadowDir, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  });

  describe("preflight", () => {
    it("returns treeValid true and the node's own treeHash when snapshotRef is set", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const tree = await snapshotter.snapshot();

      const node = makeNode({ projectId: project.id, snapshotRef: tree });
      store.upsertNode(node);

      const pf = await engine.preflight(node.id);
      expect(pf.treeHash).toBe(tree);
      expect(pf.treeValid).toBe(true);
      expect(pf.nodeId).toBe(node.id);
    });

    it("walks up to the nearest ancestor with a snapshotRef when the node's own is null", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "ancestor-content");
      const ancestorTree = await snapshotter.snapshot();

      const root = makeNode({
        projectId: project.id,
        meta: { nativeUuid: "root" },
        snapshotRef: ancestorTree,
      });
      store.upsertNode(root);

      const middle = makeNode({
        projectId: project.id,
        meta: { nativeUuid: "middle" },
        parentId: root.id,
        snapshotRef: null,
      });
      store.upsertNode(middle);

      const leaf = makeNode({
        projectId: project.id,
        meta: { nativeUuid: "leaf" },
        parentId: middle.id,
        snapshotRef: null,
      });
      store.upsertNode(leaf);

      const pf = await engine.preflight(leaf.id);
      expect(pf.treeHash).toBe(ancestorTree);
      expect(pf.treeValid).toBe(true);
    });

    it("treeValid is false and treeHash is null when no ancestor has a snapshotRef", async () => {
      const node = makeNode({ projectId: project.id, snapshotRef: null });
      store.upsertNode(node);

      const pf = await engine.preflight(node.id);
      expect(pf.treeHash).toBeNull();
      expect(pf.treeValid).toBe(false);
    });

    it("treeValid is false when the snapshotRef points to a tree the shadow repo doesn't have", async () => {
      const node = makeNode({
        projectId: project.id,
        snapshotRef: "deadbeef".repeat(5),
      });
      store.upsertNode(node);

      const pf = await engine.preflight(node.id);
      expect(pf.treeValid).toBe(false);
    });

    it("includes the fixed warnings about side effects that are NOT undone", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const tree = await snapshotter.snapshot();
      const node = makeNode({ projectId: project.id, snapshotRef: tree });
      store.upsertNode(node);

      const pf = await engine.preflight(node.id);
      const joined = pf.warnings.join(" ").toLowerCase();
      expect(joined).toContain("bash");
      expect(joined).toContain("database migration");
      expect(joined).toContain("network");
      expect(joined).toContain("push");
      expect(joined).toContain("new worktree");
    });

    it("resumeCommand is 'claude --resume <sessionId> --fork-session' for cli=claude", async () => {
      const node = makeNode({
        projectId: project.id,
        cli: "claude",
        sessionId: "sess-abc",
        snapshotRef: null,
      });
      store.upsertNode(node);

      const pf = await engine.preflight(node.id);
      expect(pf.resumeCommand).toBe("claude --resume sess-abc --fork-session");
    });

    it("resumeCommand is 'opencode --session <sessionId>' for cli=opencode", async () => {
      const node = makeNode({
        projectId: project.id,
        cli: "opencode",
        sessionId: "sess-xyz",
        meta: { nativeUuid: "oc-1" },
        snapshotRef: null,
      });
      store.upsertNode(node);

      const pf = await engine.preflight(node.id);
      expect(pf.resumeCommand).toBe("opencode --session sess-xyz");
    });

    it("throws SojournRestoreError for an unknown nodeId", async () => {
      await expect(engine.preflight("claude:does-not-exist")).rejects.toThrow(
        SojournRestoreError,
      );
    });

    it("throws SojournRestoreError with code 'not_found' for an unknown nodeId", async () => {
      await expect(engine.preflight("claude:does-not-exist")).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });

  describe("restore", () => {
    it("reproduces node-time file content in a new worktree dest", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "content-at-node-time");
      const nodeTree = await snapshotter.snapshot();

      const node = makeNode({ projectId: project.id, snapshotRef: nodeTree });
      store.upsertNode(node);

      // mutate the project after the node's snapshot, simulating later work.
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "later-mutated-content");

      const result = await engine.restore(node.id);

      const restoredContent = await fsp.readFile(
        path.join(result.worktreePath, "a.txt"),
        "utf8",
      );
      expect(restoredContent).toBe("content-at-node-time");
    });

    it("takes a safety snapshot BEFORE checkout that captures pre-restore dirty state", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const nodeTree = await snapshotter.snapshot();

      const node = makeNode({ projectId: project.id, snapshotRef: nodeTree });
      store.upsertNode(node);

      // dirty, uncommitted state before restore.
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "dirty-uncommitted-state");
      await fsp.writeFile(path.join(projectRoot, "b.txt"), "new-dirty-file");

      const result = await engine.restore(node.id);

      expect(await snapshotter.hasTree(result.safetySnapshotRef)).toBe(true);
      expect(result.safetySnapshotRef).not.toBe(nodeTree);

      // the safety snapshot tree must contain the dirty state as it was
      // right before checkout, not the checked-out (restored) state.
      const dirtyBackup = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-verify-"));
      try {
        await snapshotter.restoreToWorktree(result.safetySnapshotRef, dirtyBackup);
        const aContent = await fsp.readFile(path.join(dirtyBackup, "a.txt"), "utf8");
        const bContent = await fsp.readFile(path.join(dirtyBackup, "b.txt"), "utf8");
        expect(aContent).toBe("dirty-uncommitted-state");
        expect(bContent).toBe("new-dirty-file");
      } finally {
        fs.rmSync(dirtyBackup, { recursive: true, force: true });
      }
    });

    it("throws and creates NO worktree dir when the tree is invalid/missing", async () => {
      const node = makeNode({ projectId: project.id, snapshotRef: null });
      store.upsertNode(node);

      await expect(engine.restore(node.id)).rejects.toThrow(SojournRestoreError);

      // nothing under worktreesDir should have been created.
      const entries = fs.readdirSync(worktreesDir);
      expect(entries).toHaveLength(0);
    });

    it("throws with code 'invalid_tree' when the tree is invalid/missing", async () => {
      const node = makeNode({ projectId: project.id, snapshotRef: null });
      store.upsertNode(node);

      await expect(engine.restore(node.id)).rejects.toMatchObject({ code: "invalid_tree" });
    });

    it("throws and creates NO worktree dir when the snapshotRef points to a bogus tree", async () => {
      const node = makeNode({
        projectId: project.id,
        snapshotRef: "deadbeef".repeat(5),
      });
      store.upsertNode(node);

      await expect(engine.restore(node.id)).rejects.toThrow(SojournRestoreError);
      const entries = fs.readdirSync(worktreesDir);
      expect(entries).toHaveLength(0);
    });

    it("throws with code 'invalid_tree' when the snapshotRef points to a bogus tree", async () => {
      const node = makeNode({
        projectId: project.id,
        snapshotRef: "deadbeef".repeat(5),
      });
      store.upsertNode(node);

      await expect(engine.restore(node.id)).rejects.toMatchObject({ code: "invalid_tree" });
    });

    it("throws with code 'not_found' when the node itself does not exist", async () => {
      await expect(engine.restore("claude:does-not-exist")).rejects.toMatchObject({
        code: "not_found",
      });
    });

    it("throws with code 'dest_exhausted' when a unique worktree dest cannot be claimed", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const nodeTree = await snapshotter.snapshot();

      const fixedNow = new Date(2026, 0, 25, 8, 0, 0);
      const fixedEngine = new RestoreEngine({
        store,
        snapshotterFor: () => snapshotter,
        worktreesDir,
        now: () => fixedNow,
      });

      const node = makeNode({ projectId: project.id, snapshotRef: nodeTree });
      store.upsertNode(node);

      const node8 = node.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
      const stamp = "20260125080000";
      const baseDest = path.join(worktreesDir, project.id, `${node8}-${stamp}`);
      // Pre-create the base dest plus every suffixed candidate the engine
      // would try, so claimDest exhausts its attempts.
      fs.mkdirSync(baseDest, { recursive: true });
      for (let i = 0; i < 0x100; i++) {
        const suffix = i.toString(16).padStart(2, "0");
        fs.mkdirSync(`${baseDest}-${suffix}`, { recursive: true });
      }

      await expect(fixedEngine.restore(node.id)).rejects.toMatchObject({
        code: "dest_exhausted",
      });
    });

    it("uses the nearest ancestor's snapshotRef when the node has none of its own", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "ancestor-content");
      const ancestorTree = await snapshotter.snapshot();

      const root = makeNode({
        projectId: project.id,
        meta: { nativeUuid: "root2" },
        snapshotRef: ancestorTree,
      });
      store.upsertNode(root);

      const leaf = makeNode({
        projectId: project.id,
        meta: { nativeUuid: "leaf2" },
        parentId: root.id,
        snapshotRef: null,
      });
      store.upsertNode(leaf);

      const result = await engine.restore(leaf.id);
      const restored = await fsp.readFile(path.join(result.worktreePath, "a.txt"), "utf8");
      expect(restored).toBe("ancestor-content");
    });

    it("writes a .sojourn-restore.json manifest with the expected fields", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const nodeTree = await snapshotter.snapshot();

      const node = makeNode({
        projectId: project.id,
        snapshotRef: nodeTree,
        cli: "claude",
        sessionId: "sess-manifest",
      });
      store.upsertNode(node);

      const result = await engine.restore(node.id);

      const manifestPath = path.join(result.worktreePath, ".sojourn-restore.json");
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));

      expect(manifest.nodeId).toBe(node.id);
      expect(manifest.treeHash).toBe(nodeTree);
      expect(manifest.safetySnapshotRef).toBe(result.safetySnapshotRef);
      expect(typeof manifest.restoredAt).toBe("string");
      expect(manifest.resumeCommand).toBe("claude --resume sess-manifest --fork-session");
    });

    it("puts the worktree under <worktreesDir>/<projectId>/<node8>-<timestamp>", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const nodeTree = await snapshotter.snapshot();

      const fixedNow = new Date(2026, 0, 15, 10, 30, 45); // 2026-01-15T10:30:45 local
      const fixedEngine = new RestoreEngine({
        store,
        snapshotterFor: () => snapshotter,
        worktreesDir,
        now: () => fixedNow,
      });

      const node = makeNode({ projectId: project.id, snapshotRef: nodeTree });
      store.upsertNode(node);

      const result = await fixedEngine.restore(node.id);

      const expectedProjectDir = path.join(worktreesDir, project.id);
      expect(result.worktreePath.startsWith(expectedProjectDir)).toBe(true);

      const dirName = path.basename(result.worktreePath);
      expect(dirName).toMatch(/^[a-zA-Z0-9]{1,8}-20260115103045$/);
    });

    it("propagates the fixed warnings into the RestoreResult", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const nodeTree = await snapshotter.snapshot();
      const node = makeNode({ projectId: project.id, snapshotRef: nodeTree });
      store.upsertNode(node);

      const result = await engine.restore(node.id);
      const joined = result.warnings.join(" ").toLowerCase();
      expect(joined).toContain("bash");
      expect(joined).toContain("network");
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("never writes into projectRoot: pre-restore dirty content is untouched after a successful restore", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const nodeTree = await snapshotter.snapshot();

      const node = makeNode({ projectId: project.id, snapshotRef: nodeTree });
      store.upsertNode(node);

      // dirty, uncommitted state in the project root before restore.
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "dirty-mutated-content");
      await fsp.writeFile(path.join(projectRoot, "b.txt"), "dirty-new-file");

      await engine.restore(node.id);

      // projectRoot must still reflect the pre-restore (dirty) content —
      // restore must only ever write into the new worktree dest, never
      // back into the live project root.
      const aContent = await fsp.readFile(path.join(projectRoot, "a.txt"), "utf8");
      const bContent = await fsp.readFile(path.join(projectRoot, "b.txt"), "utf8");
      expect(aContent).toBe("dirty-mutated-content");
      expect(bContent).toBe("dirty-new-file");
    });

    it("two restores of the SAME node with the SAME injected now() land in two different dirs, each with a complete manifest", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const nodeTree = await snapshotter.snapshot();

      const fixedNow = new Date(2026, 0, 20, 9, 0, 0);
      const fixedEngine = new RestoreEngine({
        store,
        snapshotterFor: () => snapshotter,
        worktreesDir,
        now: () => fixedNow,
      });

      const node = makeNode({ projectId: project.id, snapshotRef: nodeTree });
      store.upsertNode(node);

      const first = await fixedEngine.restore(node.id);
      const second = await fixedEngine.restore(node.id);

      expect(first.worktreePath).not.toBe(second.worktreePath);

      for (const result of [first, second]) {
        const restoredContent = await fsp.readFile(
          path.join(result.worktreePath, "a.txt"),
          "utf8",
        );
        expect(restoredContent).toBe("v1");

        const manifestPath = path.join(result.worktreePath, ".sojourn-restore.json");
        expect(fs.existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
        expect(manifest.nodeId).toBe(node.id);
        expect(manifest.treeHash).toBe(nodeTree);
        expect(manifest.safetySnapshotRef).toBe(result.safetySnapshotRef);
      }

      // both dirs actually exist on disk, distinct, under the same project dir.
      const projectDir = path.join(worktreesDir, project.id);
      const entries = fs.readdirSync(projectDir);
      expect(entries).toHaveLength(2);
    });
  });
});
