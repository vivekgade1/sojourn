import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/store/index.js";
import { ShadowSnapshotter } from "../src/snapshot/index.js";
import { harvest, harvestPreflight, SojournHarvestError } from "../src/harvest/index.js";
import type { HarvestDeps, HarvestStoreLike } from "../src/harvest/index.js";
import type { SnapshotterLike } from "../src/interfaces.js";
import type { ChronoNode } from "../src/types.js";

const ORIGIN_NODE_ID = "claude:origin-node-1";

/** Recursive path -> content map for byte-identity assertions. */
async function dirContents(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out[path.relative(root, full)] = await fsp.readFile(full, "utf8");
      }
    }
  }
  await walk(root);
  return out;
}

describe("harvest engine", () => {
  let mainlineRoot: string;
  let worktreePath: string;
  let shadowDir: string;
  let baseTree: string;
  let mainSnapshotter: ShadowSnapshotter;
  /** safety-snapshot trees recorded per projectRoot, in call order */
  let safetyTrees: Map<string, string[]>;
  let tempDirs: string[];

  function realSnapshotterFor(root: string): ShadowSnapshotter {
    return new ShadowSnapshotter({ projectRoot: root, shadowDir });
  }

  /** deps whose snapshotters record every snapshotSafety() tree per root */
  function makeDeps(extra: Partial<HarvestDeps> = {}): HarvestDeps {
    return {
      snapshotterForRoot(root: string): SnapshotterLike {
        const real = realSnapshotterFor(root);
        return {
          init: () => real.init(),
          snapshot: () => real.snapshot(),
          snapshotSafety: async () => {
            const tree = await real.snapshotSafety();
            const list = safetyTrees.get(root) ?? [];
            list.push(tree);
            safetyTrees.set(root, list);
            return tree;
          },
          hasTree: (t) => real.hasTree(t),
          diff: (a, b) => real.diff(a, b),
          diffFile: (a, b, p) => real.diffFile(a, b, p),
          listFiles: (t) => real.listFiles(t),
          readFile: (t, p) => real.readFile(t, p),
          readFileRaw: (t, p) => real.readFileRaw(t, p),
          restoreToWorktree: (t, d) => real.restoreToWorktree(t, d),
        };
      },
      ...extra,
    };
  }

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function writeManifest(overrides: Record<string, unknown> = {}): Promise<void> {
    await fsp.writeFile(
      path.join(worktreePath, ".sojourn-restore.json"),
      JSON.stringify(
        {
          nodeId: ORIGIN_NODE_ID,
          treeHash: baseTree,
          safetySnapshotRef: baseTree,
          restoredAt: "2026-07-11T00:00:00.000Z",
          resumeCommand: null,
          ...overrides,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  beforeEach(async () => {
    tempDirs = [];
    safetyTrees = new Map();
    mainlineRoot = makeTempDir("sojourn-mainline-");
    worktreePath = makeTempDir("sojourn-worktree-");
    shadowDir = makeTempDir("sojourn-shadow-");

    mainSnapshotter = new ShadowSnapshotter({ projectRoot: mainlineRoot, shadowDir });
    await mainSnapshotter.init();

    // Seed the mainline project and take the "restore point" base snapshot.
    await fsp.writeFile(path.join(mainlineRoot, "shared.txt"), "line1\nline2\nline3\n");
    await fsp.writeFile(path.join(mainlineRoot, "doomed.txt"), "delete me\n");
    await fsp.mkdir(path.join(mainlineRoot, "src"), { recursive: true });
    await fsp.writeFile(path.join(mainlineRoot, "src/app.ts"), "export const x = 1;\n");
    await fsp.writeFile(path.join(mainlineRoot, "ümlaut.txt"), "üml v1\n");
    baseTree = await mainSnapshotter.snapshot();

    // Simulate a restore: materialize the base tree into a worktree + manifest.
    await mainSnapshotter.restoreToWorktree(baseTree, worktreePath);
    await writeManifest();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("harvestPreflight", () => {
    it("throws no_manifest when the worktree has no .sojourn-restore.json", async () => {
      await fsp.rm(path.join(worktreePath, ".sojourn-restore.json"));
      await expect(
        harvestPreflight(makeDeps(), worktreePath, mainlineRoot),
      ).rejects.toMatchObject({ name: "SojournHarvestError", code: "no_manifest" });
    });

    it("throws no_manifest when the manifest is invalid JSON", async () => {
      await fsp.writeFile(path.join(worktreePath, ".sojourn-restore.json"), "{nope", "utf8");
      await expect(
        harvestPreflight(makeDeps(), worktreePath, mainlineRoot),
      ).rejects.toMatchObject({ code: "no_manifest" });
    });

    it("throws no_manifest when required fields are missing", async () => {
      await writeManifest({ treeHash: undefined });
      await expect(
        harvestPreflight(makeDeps(), worktreePath, mainlineRoot),
      ).rejects.toMatchObject({ code: "no_manifest" });
    });

    it("throws stale_base when the manifest's treeHash is gone from the shadow repo", async () => {
      await writeManifest({ treeHash: "deadbeef".repeat(5) });
      await expect(
        harvestPreflight(makeDeps(), worktreePath, mainlineRoot),
      ).rejects.toMatchObject({ code: "stale_base" });
    });

    it("classifies clean / identical / conflict, reports mainlineDirty, and excludes sojourn artifacts", async () => {
      // clean: branch-only edit
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      // identical: both sides added the same file with the same content
      await fsp.writeFile(path.join(worktreePath, "same.txt"), "same content\n");
      await fsp.writeFile(path.join(mainlineRoot, "same.txt"), "same content\n");
      // conflict: divergent edits to the same line
      await fsp.writeFile(path.join(worktreePath, "shared.txt"), "line1-branch\nline2\nline3\n");
      await fsp.writeFile(path.join(mainlineRoot, "shared.txt"), "line1-mainline\nline2\nline3\n");

      const pf = await harvestPreflight(makeDeps(), worktreePath, mainlineRoot);

      expect(pf.worktreePath).toBe(worktreePath);
      expect(pf.originNodeId).toBe(ORIGIN_NODE_ID);
      expect(pf.baseTree).toBe(baseTree);
      expect(pf.branchTree).not.toBe(baseTree);
      expect(await mainSnapshotter.hasTree(pf.branchTree)).toBe(true);

      const byPath = new Map(pf.files.map((f) => [f.path, f.status]));
      expect(byPath.get("src/app.ts")).toBe("clean");
      expect(byPath.get("same.txt")).toBe("identical");
      expect(byPath.get("shared.txt")).toBe("conflict");
      expect(byPath.has(".sojourn-restore.json")).toBe(false);
      expect(byPath.has(".sojourn-harvest.patch")).toBe(false);

      expect(pf.mainlineDirty).toBe(true);

      const joined = pf.warnings.join(" ");
      expect(joined.toLowerCase()).toContain("safety snapshot");
      expect(joined).toContain("shared.txt");
      expect(joined).toContain(".git");
    });

    it("mainlineDirty is false when the mainline is untouched since the restore point", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const pf = await harvestPreflight(makeDeps(), worktreePath, mainlineRoot);
      expect(pf.mainlineDirty).toBe(false);
      expect(pf.files).toEqual([{ path: "src/app.ts", status: "clean" }]);
    });

    it("classifies a branch-added file as conflict when the mainline has a DIFFERENT file at that path", async () => {
      await fsp.writeFile(path.join(worktreePath, "new.txt"), "branch version\n");
      await fsp.writeFile(path.join(mainlineRoot, "new.txt"), "mainline version\n");

      const pf = await harvestPreflight(makeDeps(), worktreePath, mainlineRoot);
      const byPath = new Map(pf.files.map((f) => [f.path, f.status]));
      expect(byPath.get("new.txt")).toBe("conflict");
    });

    it("is read-only with respect to the mainline", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      await fsp.writeFile(path.join(mainlineRoot, "shared.txt"), "mainline moved\n");
      const before = await dirContents(mainlineRoot);

      await harvestPreflight(makeDeps(), worktreePath, mainlineRoot);

      expect(await dirContents(mainlineRoot)).toEqual(before);
    });
  });

  describe("harvest — apply mode", () => {
    it("lands a clean branch-only edit and preserves mainline-only work", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      await fsp.mkdir(path.join(worktreePath, "branch-new"), { recursive: true });
      await fsp.writeFile(path.join(worktreePath, "branch-new/deep.txt"), "from the branch\n");
      // mainline-only work, untouched by the branch
      await fsp.writeFile(path.join(mainlineRoot, "mainline-only.txt"), "mainline work\n");

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.applied.sort()).toEqual(["branch-new/deep.txt", "src/app.ts"]);
      expect(result.conflicted).toEqual([]);
      expect(result.skippedIdentical).toEqual([]);
      expect(result.patchPath).toBeNull();
      expect(result.mergeNodeId).toBeNull(); // no store injected

      expect(await fsp.readFile(path.join(mainlineRoot, "src/app.ts"), "utf8")).toBe(
        "export const x = 2;\n",
      );
      expect(await fsp.readFile(path.join(mainlineRoot, "branch-new/deep.txt"), "utf8")).toBe(
        "from the branch\n",
      );
      expect(await fsp.readFile(path.join(mainlineRoot, "mainline-only.txt"), "utf8")).toBe(
        "mainline work\n",
      );
    });

    it("takes the mainline safety snapshot BEFORE any write (snapshot holds pre-harvest state)", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      await fsp.writeFile(path.join(mainlineRoot, "mainline-only.txt"), "dirty mainline work\n");

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      const mainlineSafeties = safetyTrees.get(mainlineRoot) ?? [];
      expect(mainlineSafeties).toEqual([result.safetySnapshotRef]);
      expect(await mainSnapshotter.hasTree(result.safetySnapshotRef)).toBe(true);

      // Restoring the safety tree must reproduce the PRE-harvest mainline:
      // old src/app.ts, dirty mainline-only file present.
      const verifyDir = makeTempDir("sojourn-verify-");
      await mainSnapshotter.restoreToWorktree(result.safetySnapshotRef, verifyDir);
      expect(await fsp.readFile(path.join(verifyDir, "src/app.ts"), "utf8")).toBe(
        "export const x = 1;\n",
      );
      expect(await fsp.readFile(path.join(verifyDir, "mainline-only.txt"), "utf8")).toBe(
        "dirty mainline work\n",
      );
    });

    it("three-way merges non-overlapping edits to the SAME file (mainline edit preserved)", async () => {
      await fsp.writeFile(path.join(worktreePath, "shared.txt"), "line1\nline2\nline3-branch\n");
      await fsp.writeFile(path.join(mainlineRoot, "shared.txt"), "line1-mainline\nline2\nline3\n");

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.applied).toEqual(["shared.txt"]);
      expect(result.conflicted).toEqual([]);
      expect(await fsp.readFile(path.join(mainlineRoot, "shared.txt"), "utf8")).toBe(
        "line1-mainline\nline2\nline3-branch\n",
      );
    });

    it("skips identical files (mainline already has the branch content)", async () => {
      await fsp.writeFile(path.join(worktreePath, "shared.txt"), "converged\n");
      await fsp.writeFile(path.join(mainlineRoot, "shared.txt"), "converged\n");

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.skippedIdentical).toEqual(["shared.txt"]);
      expect(result.applied).toEqual([]);
      expect(await fsp.readFile(path.join(mainlineRoot, "shared.txt"), "utf8")).toBe("converged\n");
    });

    it("aborts CLEAN on conflict without allowConflicts: zero writes, mainline byte-identical, safety snapshot still taken", async () => {
      // conflict on shared.txt...
      await fsp.writeFile(path.join(worktreePath, "shared.txt"), "line1-branch\nline2\nline3\n");
      await fsp.writeFile(path.join(mainlineRoot, "shared.txt"), "line1-mainline\nline2\nline3\n");
      // ...alongside an otherwise-clean edit that must ALSO not be written.
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const before = await dirContents(mainlineRoot);

      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({
        name: "SojournHarvestError",
        code: "conflicts",
        files: ["shared.txt"],
      });

      expect(await dirContents(mainlineRoot)).toEqual(before);

      const mainlineSafeties = safetyTrees.get(mainlineRoot) ?? [];
      expect(mainlineSafeties).toHaveLength(1);
      expect(await mainSnapshotter.hasTree(mainlineSafeties[0])).toBe(true);
    });

    it("allowConflicts writes conflict markers and still applies clean files", async () => {
      await fsp.writeFile(path.join(worktreePath, "shared.txt"), "line1-branch\nline2\nline3\n");
      await fsp.writeFile(path.join(mainlineRoot, "shared.txt"), "line1-mainline\nline2\nline3\n");
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, {
        mode: "apply",
        allowConflicts: true,
      });

      expect(result.conflicted).toEqual(["shared.txt"]);
      expect(result.applied).toEqual(["src/app.ts"]);

      const merged = await fsp.readFile(path.join(mainlineRoot, "shared.txt"), "utf8");
      expect(merged).toContain("<<<<<<<");
      expect(merged).toContain(">>>>>>>");
      expect(merged).toContain("line1-mainline");
      expect(merged).toContain("line1-branch");

      expect(await fsp.readFile(path.join(mainlineRoot, "src/app.ts"), "utf8")).toBe(
        "export const x = 2;\n",
      );
    });

    it("deletion: branch deleted + mainline unchanged -> file deleted from mainline", async () => {
      await fsp.rm(path.join(worktreePath, "doomed.txt"));

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.applied).toEqual(["doomed.txt"]);
      expect(fs.existsSync(path.join(mainlineRoot, "doomed.txt"))).toBe(false);
    });

    it("deletion: branch deleted + mainline MODIFIED -> conflict (abort-clean, file survives)", async () => {
      await fsp.rm(path.join(worktreePath, "doomed.txt"));
      await fsp.writeFile(path.join(mainlineRoot, "doomed.txt"), "mainline kept working on it\n");

      const before = await dirContents(mainlineRoot);

      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({ code: "conflicts", files: ["doomed.txt"] });

      expect(await dirContents(mainlineRoot)).toEqual(before);
    });

    it("deletion conflict with allowConflicts writes markers preserving mainline content", async () => {
      await fsp.rm(path.join(worktreePath, "doomed.txt"));
      await fsp.writeFile(path.join(mainlineRoot, "doomed.txt"), "mainline kept working on it\n");

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, {
        mode: "apply",
        allowConflicts: true,
      });

      expect(result.conflicted).toEqual(["doomed.txt"]);
      const content = await fsp.readFile(path.join(mainlineRoot, "doomed.txt"), "utf8");
      expect(content).toContain("<<<<<<<");
      expect(content).toContain("mainline kept working on it");
    });

    it("deletion: both sides deleted -> identical skip", async () => {
      await fsp.rm(path.join(worktreePath, "doomed.txt"));
      await fsp.rm(path.join(mainlineRoot, "doomed.txt"));

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.skippedIdentical).toEqual(["doomed.txt"]);
      expect(result.applied).toEqual([]);
      expect(fs.existsSync(path.join(mainlineRoot, "doomed.txt"))).toBe(false);
    });

    it("mainline deleted a file the branch modified -> conflict", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 99;\n");
      await fsp.rm(path.join(mainlineRoot, "src/app.ts"));

      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({ code: "conflicts", files: ["src/app.ts"] });
    });

    it("throws no_manifest (after the safety snapshot) when the worktree has no manifest", async () => {
      await fsp.rm(path.join(worktreePath, ".sojourn-restore.json"));
      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({ code: "no_manifest" });
      expect(safetyTrees.get(mainlineRoot) ?? []).toHaveLength(1);
    });

    it("throws stale_base when the manifest's base tree is gone", async () => {
      await writeManifest({ treeHash: "deadbeef".repeat(5) });
      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({ code: "stale_base" });
    });
  });

  describe("harvest — patch mode", () => {
    it("writes the patch into the worktree and performs ZERO mainline writes", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      await fsp.rm(path.join(worktreePath, "doomed.txt"));
      // even a conflicting mainline edit must not matter in patch mode
      await fsp.writeFile(path.join(mainlineRoot, "src/app.ts"), "export const x = 777;\n");

      const before = await dirContents(mainlineRoot);

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "patch" });

      expect(result.patchPath).toBe(path.join(worktreePath, ".sojourn-harvest.patch"));
      expect(result.applied).toEqual([]);
      expect(result.conflicted).toEqual([]);
      expect(result.skippedIdentical).toEqual([]);
      expect(result.mergeNodeId).toBeNull();

      // mainline untouched, byte for byte
      expect(await dirContents(mainlineRoot)).toEqual(before);

      const patch = await fsp.readFile(result.patchPath!, "utf8");
      expect(patch).toContain("src/app.ts");
      expect(patch).toContain("+export const x = 2;");
      expect(patch).toContain("-export const x = 1;");
      expect(patch).toContain("doomed.txt");
      expect(patch).not.toContain(".sojourn-restore.json");

      // safety snapshot is ALWAYS taken, even in patch mode
      expect(safetyTrees.get(mainlineRoot) ?? []).toHaveLength(1);
      expect(result.safetySnapshotRef).toBe((safetyTrees.get(mainlineRoot) ?? [])[0]);
    });
  });

  describe("graph closure", () => {
    let store: GraphStore;

    beforeEach(() => {
      store = new GraphStore(":memory:");
      const project = store.upsertProject(mainlineRoot, "Mainline");
      store.upsertSession({ id: "session-1", projectId: project.id, cli: "claude" });
      const origin: ChronoNode = {
        id: ORIGIN_NODE_ID,
        parentId: null,
        kind: "checkpoint",
        cli: "claude",
        sessionId: "session-1",
        projectId: project.id,
        timestamp: "2026-07-10T00:00:00.000Z",
        snapshotRef: baseTree,
        label: null,
        summary: "origin of the restore",
        content: null,
        meta: { nativeUuid: "origin-node-1" },
      };
      store.upsertNode(origin);
    });

    afterEach(() => {
      store.close();
    });

    it("inserts a checkpoint merge node parented to the origin node with meta.forkedFrom", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const result = await harvest(makeDeps({ store }), worktreePath, mainlineRoot, {
        mode: "apply",
      });

      expect(result.mergeNodeId).not.toBeNull();
      const mergeNode = store.getNode(result.mergeNodeId!);
      expect(mergeNode).not.toBeNull();
      expect(mergeNode!.kind).toBe("checkpoint");
      expect(mergeNode!.parentId).toBe(ORIGIN_NODE_ID);
      expect(mergeNode!.meta.forkedFrom).toBe(ORIGIN_NODE_ID);
      // node8 of "claude:origin-node-1" -> "claudeor"
      expect(mergeNode!.label).toBe("harvest: 1 file from claudeor");
      expect(mergeNode!.sessionId).toBe("session-1");
      expect(mergeNode!.projectId).toBe(store.getProjects()[0].id);
    });

    it("returns mergeNodeId null when the origin node is unknown to the store", async () => {
      await writeManifest({ nodeId: "claude:some-unknown-node" });
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const result = await harvest(makeDeps({ store }), worktreePath, mainlineRoot, {
        mode: "apply",
      });

      expect(result.mergeNodeId).toBeNull();
      expect(result.applied).toEqual(["src/app.ts"]);
    });

    it("skips the merge node when nothing was applied — all-identical harvest (Minor-11)", async () => {
      await fsp.writeFile(path.join(worktreePath, "same.txt"), "same content\n");
      await fsp.writeFile(path.join(mainlineRoot, "same.txt"), "same content\n");

      const result = await harvest(makeDeps({ store }), worktreePath, mainlineRoot, {
        mode: "apply",
      });

      expect(result.skippedIdentical).toEqual(["same.txt"]);
      expect(result.mergeNodeId).toBeNull();
      expect(store.getChildren(ORIGIN_NODE_ID)).toEqual([]);
    });

    it("pluralizes the merge-node label for multiple files (Minor-11)", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      await fsp.writeFile(path.join(worktreePath, "second.txt"), "second\n");

      const result = await harvest(makeDeps({ store }), worktreePath, mainlineRoot, {
        mode: "apply",
      });

      const mergeNode = store.getNode(result.mergeNodeId!);
      expect(mergeNode!.label).toBe("harvest: 2 files from claudeor");
    });

    it("a store failure inserting the merge node degrades to a warning — the harvest still succeeds (I-7)", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      const origin = store.getNode(ORIGIN_NODE_ID)!;
      const throwingStore: HarvestStoreLike = {
        getNode: () => origin,
        upsertNode: () => {
          throw new Error("simulated store failure: disk full");
        },
      };

      const result = await harvest(
        makeDeps({ store: throwingStore }),
        worktreePath,
        mainlineRoot,
        { mode: "apply" },
      );

      expect(result.applied).toEqual(["src/app.ts"]);
      expect(result.mergeNodeId).toBeNull();
      expect(result.warnings.join(" ")).toContain("merge node");
      expect(await fsp.readFile(path.join(mainlineRoot, "src/app.ts"), "utf8")).toBe(
        "export const x = 2;\n",
      );
    });

    it("does not insert a merge node when the apply aborts on conflicts", async () => {
      await fsp.writeFile(path.join(worktreePath, "shared.txt"), "line1-branch\nline2\nline3\n");
      await fsp.writeFile(path.join(mainlineRoot, "shared.txt"), "line1-mainline\nline2\nline3\n");

      await expect(
        harvest(makeDeps({ store }), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({ code: "conflicts" });

      expect(store.getChildren(ORIGIN_NODE_ID)).toEqual([]);
    });
  });

  describe("binary safety (CRITICAL-1)", () => {
    // PNG-ish content: NUL bytes plus 0xff/0xfe sequences that are invalid
    // UTF-8 — any utf8 round-trip corrupts these into U+FFFD garbage.
    const PNG_V1 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe, 0x01,
    ]);
    const PNG_V2 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0e, 0xff, 0xfd, 0x02, 0x00,
    ]);
    const PNG_V3 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0f, 0xfe, 0xff, 0x03,
    ]);

    it("a binary file added on the branch lands byte-identical on the mainline", async () => {
      await fsp.mkdir(path.join(worktreePath, "img"), { recursive: true });
      await fsp.writeFile(path.join(worktreePath, "img/logo.png"), PNG_V1);

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.applied).toEqual(["img/logo.png"]);
      const landed = await fsp.readFile(path.join(mainlineRoot, "img/logo.png"));
      expect(Buffer.compare(landed, PNG_V1)).toBe(0);
    });

    it("a binary file modified on the branch (mainline untouched) lands byte-identical", async () => {
      await fsp.writeFile(path.join(mainlineRoot, "logo.png"), PNG_V1);
      baseTree = await mainSnapshotter.snapshot();
      await writeManifest();
      await fsp.writeFile(path.join(worktreePath, "logo.png"), PNG_V2);

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.applied).toEqual(["logo.png"]);
      const landed = await fsp.readFile(path.join(mainlineRoot, "logo.png"));
      expect(Buffer.compare(landed, PNG_V2)).toBe(0);
    });

    it("conflicting binary edits abort as a conflict — mainline bytes untouched, never text-merged", async () => {
      await fsp.writeFile(path.join(mainlineRoot, "logo.png"), PNG_V1);
      baseTree = await mainSnapshotter.snapshot();
      await writeManifest();
      await fsp.writeFile(path.join(worktreePath, "logo.png"), PNG_V2);
      await fsp.writeFile(path.join(mainlineRoot, "logo.png"), PNG_V3);

      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({
        name: "SojournHarvestError",
        code: "conflicts",
        files: ["logo.png"],
      });

      const untouched = await fsp.readFile(path.join(mainlineRoot, "logo.png"));
      expect(Buffer.compare(untouched, PNG_V3)).toBe(0);
    });

    it("allowConflicts reports a binary conflict but NEVER writes markers into it", async () => {
      await fsp.writeFile(path.join(mainlineRoot, "logo.png"), PNG_V1);
      baseTree = await mainSnapshotter.snapshot();
      await writeManifest();
      await fsp.writeFile(path.join(worktreePath, "logo.png"), PNG_V2);
      await fsp.writeFile(path.join(mainlineRoot, "logo.png"), PNG_V3);
      // a clean text edit alongside must still land
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, {
        mode: "apply",
        allowConflicts: true,
      });

      expect(result.conflicted).toEqual(["logo.png"]);
      expect(result.applied).toEqual(["src/app.ts"]);
      expect(result.warnings.join(" ")).toContain("logo.png");
      const untouched = await fsp.readFile(path.join(mainlineRoot, "logo.png"));
      expect(Buffer.compare(untouched, PNG_V3)).toBe(0);
    });
  });

  describe("symlink safety (CRITICAL-2)", () => {
    it("mainline symlink at the destination -> conflict; the external target is never written through", async () => {
      const outside = makeTempDir("sojourn-outside-");
      const target = path.join(outside, "target.txt");
      // The target holds EXACTLY the base content, so a lexical-only engine
      // classifies "clean" and clobbers the target straight through the link.
      await fsp.writeFile(target, "line1\nline2\nline3\n");
      await fsp.rm(path.join(mainlineRoot, "shared.txt"));
      await fsp.symlink(target, path.join(mainlineRoot, "shared.txt"));

      await fsp.writeFile(path.join(worktreePath, "shared.txt"), "line1-branch\nline2\nline3\n");

      const pf = await harvestPreflight(makeDeps(), worktreePath, mainlineRoot);
      expect(new Map(pf.files.map((f) => [f.path, f.status])).get("shared.txt")).toBe("conflict");

      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({ code: "conflicts", files: ["shared.txt"] });

      expect(await fsp.readFile(target, "utf8")).toBe("line1\nline2\nline3\n");
      expect((await fsp.lstat(path.join(mainlineRoot, "shared.txt"))).isSymbolicLink()).toBe(true);
    });

    it("symlinked intermediate directory escaping the root -> conflict; nothing lands outside", async () => {
      const outsideDir = makeTempDir("sojourn-outside-");
      await fsp.symlink(outsideDir, path.join(mainlineRoot, "sub"));

      await fsp.mkdir(path.join(worktreePath, "sub"), { recursive: true });
      await fsp.writeFile(path.join(worktreePath, "sub/new.txt"), "branch payload\n");

      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({ code: "conflicts", files: ["sub/new.txt"] });

      expect(fs.existsSync(path.join(outsideDir, "new.txt"))).toBe(false);
    });

    it("an intermediate symlink that stays INSIDE the root is allowed", async () => {
      await fsp.mkdir(path.join(mainlineRoot, "realdir"), { recursive: true });
      await fsp.symlink(path.join(mainlineRoot, "realdir"), path.join(mainlineRoot, "alias"));

      await fsp.mkdir(path.join(worktreePath, "alias"), { recursive: true });
      await fsp.writeFile(path.join(worktreePath, "alias/file.txt"), "in-root payload\n");

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.applied).toEqual(["alias/file.txt"]);
      expect(await fsp.readFile(path.join(mainlineRoot, "realdir/file.txt"), "utf8")).toBe(
        "in-root payload\n",
      );
    });
  });

  describe("dir/file collision (I-3)", () => {
    it("a directory occupying the destination classifies as conflict — no raw mid-apply crash", async () => {
      await fsp.writeFile(path.join(worktreePath, "blob"), "branch file content\n");
      await fsp.mkdir(path.join(mainlineRoot, "blob"), { recursive: true });
      await fsp.writeFile(path.join(mainlineRoot, "blob/inner.txt"), "keep me\n");

      const pf = await harvestPreflight(makeDeps(), worktreePath, mainlineRoot);
      expect(new Map(pf.files.map((f) => [f.path, f.status])).get("blob")).toBe("conflict");

      await expect(
        harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({
        name: "SojournHarvestError",
        code: "conflicts",
        files: ["blob"],
      });

      // allowConflicts still never writes into/over the directory
      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, {
        mode: "apply",
        allowConflicts: true,
      });
      expect(result.conflicted).toEqual(["blob"]);
      expect(await fsp.readFile(path.join(mainlineRoot, "blob/inner.txt"), "utf8")).toBe(
        "keep me\n",
      );
    });
  });

  describe("mid-apply failure honesty (I-4)", () => {
    it("wraps a write failure in partial_apply carrying applied/conflicted/remaining/safety ref", async () => {
      await fsp.writeFile(path.join(worktreePath, "a-first.txt"), "landed before the failure\n");
      await fsp.mkdir(path.join(worktreePath, "locked"), { recursive: true });
      await fsp.writeFile(path.join(worktreePath, "locked/z.txt"), "will fail to land\n");
      await fsp.mkdir(path.join(mainlineRoot, "locked"), { recursive: true });
      await fsp.chmod(path.join(mainlineRoot, "locked"), 0o555);

      let caught: unknown;
      try {
        await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });
      } catch (err) {
        caught = err;
      } finally {
        await fsp.chmod(path.join(mainlineRoot, "locked"), 0o755);
      }

      expect(caught).toMatchObject({
        name: "SojournHarvestError",
        code: "partial_apply",
        files: ["locked/z.txt"],
        partial: {
          applied: ["a-first.txt"],
          conflicted: [],
          remaining: ["locked/z.txt"],
        },
      });
      const partial = (caught as SojournHarvestError).partial!;
      expect(partial.safetySnapshotRef).toMatch(/^[0-9a-f]{40}$/);
      expect(await mainSnapshotter.hasTree(partial.safetySnapshotRef)).toBe(true);

      // the file that landed before the failure really is on the mainline
      expect(await fsp.readFile(path.join(mainlineRoot, "a-first.txt"), "utf8")).toBe(
        "landed before the failure\n",
      );
    });
  });

  describe("mainline drift between classification and write (I-6)", () => {
    it("aborts with mainline_drift; raced content survives byte-identical", async () => {
      await fsp.writeFile(path.join(worktreePath, "aaa.txt"), "branch aaa\n");
      await fsp.writeFile(path.join(worktreePath, "bbb.txt"), "branch bbb\n");

      const inner = makeDeps();
      const deps: HarvestDeps = {
        snapshotterForRoot(root: string): SnapshotterLike {
          const snap = inner.snapshotterForRoot(root);
          if (root !== worktreePath) return snap;
          return {
            ...snap,
            // While the engine classifies bbb.txt (AFTER aaa.txt was read),
            // the mainline gains its own aaa.txt — a process racing harvest.
            readFileRaw: async (tree, p) => {
              if (p === "bbb.txt") {
                await fsp.writeFile(
                  path.join(mainlineRoot, "aaa.txt"),
                  "sneaky concurrent write\n",
                );
              }
              return snap.readFileRaw!(tree, p);
            },
          };
        },
      };

      let caught: unknown;
      try {
        await harvest(deps, worktreePath, mainlineRoot, { mode: "apply" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toMatchObject({
        name: "SojournHarvestError",
        code: "mainline_drift",
        files: ["aaa.txt"],
        partial: { applied: [], conflicted: [], remaining: ["aaa.txt", "bbb.txt"] },
      });
      // The raced content exists in NO snapshot — overwriting it would have
      // been unrecoverable data loss.
      expect(await fsp.readFile(path.join(mainlineRoot, "aaa.txt"), "utf8")).toBe(
        "sneaky concurrent write\n",
      );
      expect(fs.existsSync(path.join(mainlineRoot, "bbb.txt"))).toBe(false);
    });
  });

  describe("read-failure honesty (probe-proven: a failed branch read must never look like a deletion)", () => {
    // Historical bug: ShadowSnapshotter.readFileRaw's catch-all returned
    // null on ANY failure, including a 64MB maxBuffer overrun on a large
    // branch file. classifyFile read that null as "the branch deleted the
    // file" — a 65MB branch file classified "clean" and the mainline copy
    // was DELETED, reported as a successful apply. Fixed at two layers:
    // (1) ShadowSnapshotter.readFile/readFileRaw now only return null when
    // git's own stderr confirms genuine absence, and throw otherwise; (2)
    // classifyFile treats a null branch read as an error (not a deletion)
    // whenever the diff itself reports the path present (status A/M) — so
    // even a DIFFERENT SnapshotterLike implementation that still conflates
    // "failed" with "absent" cannot reproduce this bug through harvest().

    it("a thrown branch read (e.g. maxBuffer) aborts with read_failed BEFORE any mainline write", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      const before = await dirContents(mainlineRoot);

      const inner = makeDeps();
      const deps: HarvestDeps = {
        snapshotterForRoot(root: string): SnapshotterLike {
          const snap = inner.snapshotterForRoot(root);
          if (root !== worktreePath) return snap;
          return {
            ...snap,
            // Simulates the real ERR_CHILD_PROCESS_STDIO_MAXBUFFER failure a
            // 65MB branch file would hit.
            readFileRaw: async (tree, p) => {
              if (p === "src/app.ts") throw new Error("stdout maxBuffer length exceeded");
              return snap.readFileRaw!(tree, p);
            },
          };
        },
      };

      let caught: unknown;
      try {
        await harvest(deps, worktreePath, mainlineRoot, { mode: "apply" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toMatchObject({
        name: "SojournHarvestError",
        code: "read_failed",
        files: ["src/app.ts"],
      });
      // Abort-clean: classification always finishes (or fails) BEFORE any
      // mainline write, so the ONLY thing this run produced is the
      // unconditional mainline safety snapshot — the mainline tree itself
      // is byte-identical to before the call.
      expect(await dirContents(mainlineRoot)).toEqual(before);
      expect(safetyTrees.get(mainlineRoot) ?? []).toHaveLength(1);
    });

    it("a branch read returning null for a path the diff reports PRESENT is also a hard read_failed error, not a silent deletion", async () => {
      // Defense in depth: reproduces the historical bug shape directly — a
      // snapshotter that conflates "read failed" with "path absent" and
      // returns null instead of throwing. harvestEngine must not trust that
      // null as "the branch deleted the file" when the diff says the path
      // is present (status M here, not D).
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");
      const before = await dirContents(mainlineRoot);

      const inner = makeDeps();
      const deps: HarvestDeps = {
        snapshotterForRoot(root: string): SnapshotterLike {
          const snap = inner.snapshotterForRoot(root);
          if (root !== worktreePath) return snap;
          return {
            ...snap,
            readFileRaw: async (tree, p) => (p === "src/app.ts" ? null : snap.readFileRaw!(tree, p)),
          };
        },
      };

      await expect(
        harvest(deps, worktreePath, mainlineRoot, { mode: "apply" }),
      ).rejects.toMatchObject({
        name: "SojournHarvestError",
        code: "read_failed",
        files: ["src/app.ts"],
      });

      expect(await dirContents(mainlineRoot)).toEqual(before);
      expect(fs.existsSync(path.join(mainlineRoot, "src/app.ts"))).toBe(true);
    });

    it("harvestPreflight also surfaces read_failed instead of silently misclassifying an unreadable branch file", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const inner = makeDeps();
      const deps: HarvestDeps = {
        snapshotterForRoot(root: string): SnapshotterLike {
          const snap = inner.snapshotterForRoot(root);
          if (root !== worktreePath) return snap;
          return {
            ...snap,
            readFileRaw: async (tree, p) => {
              if (p === "src/app.ts") throw new Error("stdout maxBuffer length exceeded");
              return snap.readFileRaw!(tree, p);
            },
          };
        },
      };

      await expect(harvestPreflight(deps, worktreePath, mainlineRoot)).rejects.toMatchObject({
        name: "SojournHarvestError",
        code: "read_failed",
        files: ["src/app.ts"],
      });
    });
  });

  describe("patch generation honesty (Minor-9)", () => {
    it("throws patch_incomplete instead of silently writing a partial patch", async () => {
      await fsp.writeFile(path.join(worktreePath, "shared.txt"), "line1-branch\nline2\nline3\n");
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const inner = makeDeps();
      const deps: HarvestDeps = {
        snapshotterForRoot(root: string): SnapshotterLike {
          const snap = inner.snapshotterForRoot(root);
          if (root !== worktreePath) return snap;
          return {
            ...snap,
            // ShadowSnapshotter.diffFile swallows git failures into "" — the
            // engine must treat an empty diff for a CHANGED path as a failure.
            diffFile: async (a, b, p) => (p === "src/app.ts" ? "" : snap.diffFile(a, b, p)),
          };
        },
      };

      await expect(
        harvest(deps, worktreePath, mainlineRoot, { mode: "patch" }),
      ).rejects.toMatchObject({
        name: "SojournHarvestError",
        code: "patch_incomplete",
        files: ["src/app.ts"],
      });

      expect(fs.existsSync(path.join(worktreePath, ".sojourn-harvest.patch"))).toBe(false);
    });
  });

  describe("delete/modify with a clean content resolution (Minor-12)", () => {
    it("classifies by the ACTUAL merge outcome: branch delete + mainline truncation resolves clean", async () => {
      await fsp.rm(path.join(worktreePath, "doomed.txt"));
      await fsp.writeFile(path.join(mainlineRoot, "doomed.txt"), ""); // truncated, not deleted

      // git merge-file resolves this marker-lessly, so it must land in
      // `applied` WITHOUT allowConflicts — not abort as a fake conflict.
      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });

      expect(result.applied).toEqual(["doomed.txt"]);
      expect(result.conflicted).toEqual([]);
      expect(fs.existsSync(path.join(mainlineRoot, "doomed.txt"))).toBe(false);
    });
  });

  describe("non-ASCII filenames (I-5)", () => {
    it("an edit to ümlaut.txt round-trips through preflight + apply with the real path string", async () => {
      await fsp.writeFile(path.join(worktreePath, "ümlaut.txt"), "üml v2\n");

      const pf = await harvestPreflight(makeDeps(), worktreePath, mainlineRoot);
      expect(pf.files).toEqual([{ path: "ümlaut.txt", status: "clean" }]);

      const result = await harvest(makeDeps(), worktreePath, mainlineRoot, { mode: "apply" });
      expect(result.applied).toEqual(["ümlaut.txt"]);
      expect(await fsp.readFile(path.join(mainlineRoot, "ümlaut.txt"), "utf8")).toBe("üml v2\n");
    });
  });

  describe("readFileRaw-absent fallback (Minor: exercise + honestly pin readTreeRaw's utf8 path)", () => {
    /** A worktree-rooted snapshotter with NO readFileRaw method at all,
     * forcing harvestEngine's readTreeRaw() to fall back to the utf8
     * readFile() + Buffer.from(text, "utf8") path. Previously untested.
     * ShadowSnapshotter always implements readFileRaw; this fallback exists
     * only for minimal SnapshotterLike stubs. */
    function makeDepsNoReadFileRawForWorktree(): HarvestDeps {
      const inner = makeDeps();
      return {
        snapshotterForRoot(root: string): SnapshotterLike {
          const snap = inner.snapshotterForRoot(root);
          if (root !== worktreePath) return snap;
          const { readFileRaw: _omit, ...rest } = snap;
          return rest;
        },
      };
    }

    it("plain text harvests correctly through the utf8 fallback", async () => {
      await fsp.writeFile(path.join(worktreePath, "src/app.ts"), "export const x = 2;\n");

      const result = await harvest(makeDepsNoReadFileRawForWorktree(), worktreePath, mainlineRoot, {
        mode: "apply",
      });

      expect(result.applied).toEqual(["src/app.ts"]);
      expect(await fsp.readFile(path.join(mainlineRoot, "src/app.ts"), "utf8")).toBe(
        "export const x = 2;\n",
      );
    });

    it("PINNED (documented limitation, not fixed): binary content is corrupted by the utf8 round-trip, not preserved byte-identical", async () => {
      // readTreeRaw's fallback is Buffer.from(await snap.readFile(...), "utf8").
      // readFile() decodes git's raw stdout as utf8 FIRST — any invalid byte
      // sequence in binary content becomes U+FFFD — and that mangled string
      // is what gets re-encoded, not the original bytes. NUL bytes happen to
      // survive the round trip unchanged, so isBinary()'s NUL-byte sniff
      // still fires and classifyFile still takes its "binary" branches —
      // but the content that actually lands is the corrupted reconstruction,
      // not the true branch bytes. This is a pre-existing, documented
      // limitation of the fallback (see readTreeRaw's doc comment) and is
      // NOT fixed here: ShadowSnapshotter always provides readFileRaw in
      // production, so real harvests never take this path.
      const PNG = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe, 0x01,
      ]);
      await fsp.mkdir(path.join(worktreePath, "img"), { recursive: true });
      await fsp.writeFile(path.join(worktreePath, "img/logo.png"), PNG);

      const result = await harvest(makeDepsNoReadFileRawForWorktree(), worktreePath, mainlineRoot, {
        mode: "apply",
      });

      // The engine still reports this as a clean apply (isBinary still
      // fires on the corrupted-but-NUL-containing buffer, and mainline had
      // no prior copy to conflict with) ...
      expect(result.applied).toEqual(["img/logo.png"]);
      // ... but pin the honest reality: what landed is NOT the original
      // branch bytes.
      const landed = await fsp.readFile(path.join(mainlineRoot, "img/logo.png"));
      expect(Buffer.compare(landed, PNG)).not.toBe(0);
    });
  });

  it("exposes the typed error class", () => {
    const err = new SojournHarvestError("boom", "conflicts", ["a.txt"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SojournHarvestError");
    expect(err.code).toBe("conflicts");
    expect(err.files).toEqual(["a.txt"]);
  });
});
