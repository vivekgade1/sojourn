import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShadowSnapshotter } from "../src/snapshot/index.js";

describe("ShadowSnapshotter", () => {
  let projectRoot: string;
  let shadowDir: string;
  let snapshotter: ShadowSnapshotter;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-project-"));
    shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-shadow-"));
    snapshotter = new ShadowSnapshotter({ projectRoot, shadowDir });
    await snapshotter.init();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(shadowDir, { recursive: true, force: true });
  });

  it("never creates a .git directory inside the project root", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");
    await snapshotter.snapshot();
    expect(fs.existsSync(path.join(projectRoot, ".git"))).toBe(false);
  });

  it("init() sets up the shadow repo with an info/exclude file and shadow config", () => {
    expect(fs.existsSync(path.join(shadowDir, "info", "exclude"))).toBe(true);
    const excludeContents = fs.readFileSync(
      path.join(shadowDir, "info", "exclude"),
      "utf8",
    );
    for (const entry of [
      ".git/",
      "node_modules/",
      "dist/",
      "build/",
      "out/",
      ".next/",
      ".cache/",
      "*.log",
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      ".sojourn/",
      ".DS_Store",
    ]) {
      expect(excludeContents).toContain(entry);
    }
  });

  it("produces different tree hashes when file contents change", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
    const tree1 = await snapshotter.snapshot();

    await fsp.writeFile(path.join(projectRoot, "a.txt"), "v2");
    const tree2 = await snapshotter.snapshot();

    expect(tree1).not.toBe(tree2);
    expect(tree1).toMatch(/^[0-9a-f]{40}$/);
    expect(tree2).toMatch(/^[0-9a-f]{40}$/);
  });

  it("dedups: snapshotting with no changes produces an identical tree hash", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "same content");
    const tree1 = await snapshotter.snapshot();
    const tree2 = await snapshotter.snapshot();
    expect(tree1).toBe(tree2);
  });

  it("diff() reports added, modified, and deleted files correctly", async () => {
    await fsp.writeFile(path.join(projectRoot, "keep.txt"), "unchanged");
    await fsp.writeFile(path.join(projectRoot, "modify.txt"), "before");
    await fsp.writeFile(path.join(projectRoot, "remove.txt"), "bye");
    const tree1 = await snapshotter.snapshot();

    await fsp.writeFile(path.join(projectRoot, "modify.txt"), "after");
    await fsp.rm(path.join(projectRoot, "remove.txt"));
    await fsp.writeFile(path.join(projectRoot, "add.txt"), "new file");
    const tree2 = await snapshotter.snapshot();

    const changes = await snapshotter.diff(tree1, tree2);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));

    expect(byPath["modify.txt"]).toBe("M");
    expect(byPath["remove.txt"]).toBe("D");
    expect(byPath["add.txt"]).toBe("A");
    expect(byPath["keep.txt"]).toBeUndefined();
  });

  it("diff() with a null base treats all files in the tree as added (--root)", async () => {
    await fsp.writeFile(path.join(projectRoot, "one.txt"), "1");
    await fsp.writeFile(path.join(projectRoot, "two.txt"), "2");
    const tree = await snapshotter.snapshot();

    const changes = await snapshotter.diff(null, tree);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));

    expect(byPath["one.txt"]).toBe("A");
    expect(byPath["two.txt"]).toBe("A");
  });

  it("diffFile() returns a unified diff for a changed path and empty string for no change", async () => {
    await fsp.writeFile(path.join(projectRoot, "f.txt"), "line1\n");
    const tree1 = await snapshotter.snapshot();

    await fsp.writeFile(path.join(projectRoot, "f.txt"), "line1\nline2\n");
    const tree2 = await snapshotter.snapshot();

    const patch = await snapshotter.diffFile(tree1, tree2, "f.txt");
    expect(patch).toContain("f.txt");
    expect(patch).toContain("+line2");

    const noPatch = await snapshotter.diffFile(tree1, tree1, "f.txt");
    expect(noPatch).toBe("");
  });

  it("excludes node_modules, dist, and other ignored paths from listFiles", async () => {
    await fsp.mkdir(path.join(projectRoot, "node_modules"), { recursive: true });
    await fsp.writeFile(
      path.join(projectRoot, "node_modules", "x.js"),
      "ignored",
    );
    await fsp.mkdir(path.join(projectRoot, "dist"), { recursive: true });
    await fsp.writeFile(path.join(projectRoot, "dist", "bundle.js"), "ignored");
    await fsp.writeFile(path.join(projectRoot, "real.txt"), "tracked");

    const tree = await snapshotter.snapshot();
    const files = await snapshotter.listFiles(tree);

    expect(files).toContain("real.txt");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files.some((f) => f.startsWith("dist/"))).toBe(false);
  });

  it("hasTree() returns true for a real tree and false for a bogus hash", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "content");
    const tree = await snapshotter.snapshot();

    expect(await snapshotter.hasTree(tree)).toBe(true);
    expect(await snapshotter.hasTree("deadbeef".repeat(5))).toBe(false);
  });

  it("readFile() returns file content by tree+path and null when missing", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello world");
    const tree = await snapshotter.snapshot();

    expect(await snapshotter.readFile(tree, "a.txt")).toBe("hello world");
    expect(await snapshotter.readFile(tree, "missing.txt")).toBeNull();
  });

  it("restoreToWorktree() reproduces byte-identical content in a fresh dest without touching projectRoot", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "snapshot-1-content");
    const tree1 = await snapshotter.snapshot();

    // mutate projectRoot after snapshot 1
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "mutated-content");
    await snapshotter.snapshot();

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-restore-"));
    try {
      await snapshotter.restoreToWorktree(tree1, dest);

      const restored = await fsp.readFile(path.join(dest, "a.txt"), "utf8");
      expect(restored).toBe("snapshot-1-content");

      // projectRoot keeps the mutated state
      const projectContent = await fsp.readFile(
        path.join(projectRoot, "a.txt"),
        "utf8",
      );
      expect(projectContent).toBe("mutated-content");
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it("restoreToWorktree() does not leave a stray temporary index file in shadowDir", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "content");
    const tree = await snapshotter.snapshot();

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-restore-"));
    try {
      await snapshotter.restoreToWorktree(tree, dest);
      const entries = fs.readdirSync(shadowDir);
      const strayIndexes = entries.filter((e) => e.startsWith("restore-index-"));
      expect(strayIndexes).toHaveLength(0);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
