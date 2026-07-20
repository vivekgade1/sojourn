import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShadowSnapshotter, SojournSnapshotError } from "../src/snapshot/index.js";
import { runGit } from "../src/snapshot/git.js";

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
      "*.p12",
      "*.keystore",
      "id_rsa",
      "id_rsa.*",
      "*.token",
      "credentials",
      "credentials.*",
      ".aws/",
      ".ssh/",
      "*.secret",
      "*.pfx",
      ".sojourn-restore.json",
      ".sojourn-harvest.patch",
    ]) {
      expect(excludeContents).toContain(entry);
    }
  });

  it("never lets planted secrets (.env, id_rsa, .aws/credentials, and friends) into listFiles()", async () => {
    await fsp.writeFile(path.join(projectRoot, ".env"), "SECRET=shh");
    await fsp.writeFile(path.join(projectRoot, ".env.production"), "SECRET=shh-prod");
    await fsp.writeFile(path.join(projectRoot, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    await fsp.writeFile(path.join(projectRoot, "id_rsa.pub"), "ssh-rsa AAAA...");
    await fsp.writeFile(path.join(projectRoot, "server.p12"), "binary-cert-bytes");
    await fsp.writeFile(path.join(projectRoot, "app.keystore"), "binary-keystore-bytes");
    await fsp.writeFile(path.join(projectRoot, "app.pfx"), "binary-pfx-bytes");
    await fsp.writeFile(path.join(projectRoot, "api.token"), "tok_abc123");
    await fsp.writeFile(path.join(projectRoot, "credentials"), "aws_access_key_id=AKIA...");
    await fsp.writeFile(path.join(projectRoot, "credentials.json"), '{"key":"secret"}');
    await fsp.writeFile(path.join(projectRoot, "notes.secret"), "shh");
    await fsp.mkdir(path.join(projectRoot, ".aws"), { recursive: true });
    await fsp.writeFile(path.join(projectRoot, ".aws", "credentials"), "aws_secret_access_key=...");
    await fsp.mkdir(path.join(projectRoot, ".ssh"), { recursive: true });
    await fsp.writeFile(path.join(projectRoot, ".ssh", "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    await fsp.writeFile(path.join(projectRoot, "real.txt"), "tracked, not a secret");

    const tree = await snapshotter.snapshot();
    const files = await snapshotter.listFiles(tree);

    expect(files).toContain("real.txt");
    for (const secretPath of [
      ".env",
      ".env.production",
      "id_rsa",
      "id_rsa.pub",
      "server.p12",
      "app.keystore",
      "app.pfx",
      "api.token",
      "credentials",
      "credentials.json",
      "notes.secret",
      ".aws/credentials",
      ".ssh/id_rsa",
    ]) {
      expect(files).not.toContain(secretPath);
    }
  });

  it("never captures sojourn's own restore/harvest artifacts, at the root or nested in a restore worktree", async () => {
    // Restoring a worktree-session node materializes a .sojourn-harvest.patch
    // that is STALE the moment the working tree moves on; snapshotting it
    // would let a user `git apply` it believing it fresh. Every real consumer
    // reads these off the live filesystem, never out of a snapshot.
    await fsp.writeFile(
      path.join(projectRoot, ".sojourn-restore.json"),
      '{"nodeId":"claude:abc"}',
    );
    await fsp.writeFile(
      path.join(projectRoot, ".sojourn-harvest.patch"),
      "diff --git a/x b/x\n",
    );
    // Nested too — the entries are bare basenames, NOT "/"-anchored, so a
    // restore worktree checked out under the project root is covered.
    await fsp.mkdir(path.join(projectRoot, "worktrees", "claude-node-1"), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(projectRoot, "worktrees", "claude-node-1", ".sojourn-restore.json"),
      '{"nodeId":"claude:def"}',
    );
    await fsp.writeFile(
      path.join(projectRoot, "worktrees", "claude-node-1", ".sojourn-harvest.patch"),
      "diff --git a/y b/y\n",
    );
    await fsp.writeFile(path.join(projectRoot, "real.txt"), "tracked");

    const tree = await snapshotter.snapshot();
    const files = await snapshotter.listFiles(tree);

    expect(files).toContain("real.txt");
    for (const artifact of [
      ".sojourn-restore.json",
      ".sojourn-harvest.patch",
      "worktrees/claude-node-1/.sojourn-restore.json",
      "worktrees/claude-node-1/.sojourn-harvest.patch",
    ]) {
      expect(files).not.toContain(artifact);
    }
  });

  it("init() sweeps the orphaned pre-upgrade 'sojourn-index' while leaving every live index file alone", async () => {
    // Pre-C1 shadow dirs carry a bare `sojourn-index` that nothing references
    // anymore. The predicate must be EXACT-MATCH: a `sojourn-index*` glob
    // would also delete the live per-root indices mid-snapshot.
    await fsp.writeFile(path.join(shadowDir, "sojourn-index"), "legacy");
    await fsp.writeFile(path.join(shadowDir, "sojourn-index-deadbeef"), "live per-root");
    await fsp.writeFile(path.join(shadowDir, "safety-index-0123456789abcdef"), "live temp");
    await fsp.writeFile(path.join(shadowDir, "sojourn-gc-index"), "live gc");

    await snapshotter.init();

    expect(fs.existsSync(path.join(shadowDir, "sojourn-index"))).toBe(false);
    expect(fs.existsSync(path.join(shadowDir, "sojourn-index-deadbeef"))).toBe(true);
    expect(fs.existsSync(path.join(shadowDir, "safety-index-0123456789abcdef"))).toBe(true);
    expect(fs.existsSync(path.join(shadowDir, "sojourn-gc-index"))).toBe(true);

    // Idempotent: a second init() on a shadow dir with no legacy index is a
    // no-op, not a failure.
    await snapshotter.init();
    expect(fs.existsSync(path.join(shadowDir, "sojourn-index"))).toBe(false);

    // And snapshotting still works afterwards (the live index is intact).
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "after-sweep");
    expect(await snapshotter.readFile(await snapshotter.snapshot(), "a.txt")).toBe(
      "after-sweep",
    );
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

  it("diffFile() with a null base diffs against the empty tree, returning the added content on the first snapshot", async () => {
    await fsp.writeFile(
      path.join(projectRoot, "file.txt"),
      "snapshot-1-content\n",
    );
    const tree = await snapshotter.snapshot();

    const patch = await snapshotter.diffFile(null, tree, "file.txt");
    expect(patch).not.toBe("");
    expect(patch).toContain("file.txt");
    expect(patch).toContain("+snapshot-1-content");
  });

  it("diff() reports a renamed file with unchanged content as status R with oldPath set", async () => {
    await fsp.writeFile(
      path.join(projectRoot, "old-name.txt"),
      "unchanged rename content\n",
    );
    const tree1 = await snapshotter.snapshot();

    await fsp.rename(
      path.join(projectRoot, "old-name.txt"),
      path.join(projectRoot, "new-name.txt"),
    );
    const tree2 = await snapshotter.snapshot();

    const changes = await snapshotter.diff(tree1, tree2);
    const renameEntries = changes.filter((c) => c.status === "R");

    expect(renameEntries).toHaveLength(1);
    expect(renameEntries[0].path).toBe("new-name.txt");
    expect(renameEntries[0].oldPath).toBe("old-name.txt");
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

  it("readFileRaw() round-trips binary content byte-identical and returns null when missing", async () => {
    // PNG-ish header: NUL bytes + sequences that are invalid UTF-8 (0xff 0xfe).
    const bin = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0x00, 0x01, 0x02, 0x03,
    ]);
    await fsp.writeFile(path.join(projectRoot, "logo.png"), bin);
    const tree = await snapshotter.snapshot();

    const raw = await snapshotter.readFileRaw(tree, "logo.png");
    expect(raw).not.toBeNull();
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(Buffer.compare(raw!, bin)).toBe(0);

    expect(await snapshotter.readFileRaw(tree, "missing.png")).toBeNull();
  });

  it("readFile() and readFileRaw() propagate a real git failure — do NOT swallow it into null like a genuine absence", async () => {
    // Probe-proven bug (see harvest.test.ts "read-failure honesty"): the old
    // catch-all here returned null on ANY failure, including ones that have
    // nothing to do with the path being absent (a 64MB maxBuffer overrun on
    // a large blob, a bad tree, a spawn error). harvestEngine's classifier
    // then read that null as "the file doesn't exist on this side" and, for
    // a branch read, as "the branch deleted the file" — silently deleting a
    // mainline file that in fact still existed on the branch.
    //
    // "not-a-real-tree" is not a resolvable git object at all — its stderr
    // is "fatal: invalid object name 'not-a-real-tree'.", which does NOT
    // match the "path ... does not exist in <tree>" absence pattern git uses
    // when a TREE is valid but a PATH within it is missing. This must
    // reject, not resolve to null.
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");
    await snapshotter.snapshot();

    await expect(snapshotter.readFile("not-a-real-tree", "a.txt")).rejects.toThrow();
    await expect(snapshotter.readFileRaw("not-a-real-tree", "a.txt")).rejects.toThrow();
  });

  it("diff() and listFiles() return non-ASCII paths verbatim (no core.quotepath octal quoting)", async () => {
    await fsp.writeFile(path.join(projectRoot, "ümlaut.txt"), "v1\n");
    const t1 = await snapshotter.snapshot();
    await fsp.writeFile(path.join(projectRoot, "ümlaut.txt"), "v2\n");
    const t2 = await snapshotter.snapshot();

    const changes = await snapshotter.diff(t1, t2);
    expect(changes).toEqual([{ path: "ümlaut.txt", status: "M" }]);

    expect(await snapshotter.listFiles(t2)).toContain("ümlaut.txt");
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

  it("snapshotSafety() captures the same tree as snapshot(), touches neither the shared index chain nor refs/sojourn/head, and runs concurrently with snapshot()", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    await fs.writeFile(path.join(projectRoot, "s.txt"), "state-1");
    const regular = await snapshotter.snapshot();

    // Same working tree -> the safety snapshot must produce the SAME tree hash.
    const safety = await snapshotter.snapshotSafety();
    expect(safety).toBe(regular);
    expect(await snapshotter.hasTree(safety)).toBe(true);

    // Interleave: run a safety snapshot CONCURRENTLY with a regular snapshot
    // after mutating the tree — both must succeed (no index.lock collision).
    await fs.writeFile(path.join(projectRoot, "s.txt"), "state-2");
    const [a, b] = await Promise.all([snapshotter.snapshot(), snapshotter.snapshotSafety()]);
    expect(a).toBe(b); // identical working tree, identical tree hash
    expect(await snapshotter.hasTree(a)).toBe(true);

    // No stray safety temp index left behind.
    const leftovers = (await fs.readdir(shadowDir)).filter((f) => f.startsWith("safety-index-"));
    expect(leftovers).toEqual([]);
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

  it("throws a typed SojournSnapshotError (code 'cas_exhausted', carrying the unrecorded tree) when the head CAS never lands", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "never-recorded");

    // Force EVERY update-ref to fail without shrinking MAX_HEAD_CAS_ATTEMPTS:
    // git acquires refs/sojourn/head.lock with O_CREAT|O_EXCL, so a
    // pre-existing lock file makes the ref write fail deterministically on
    // every attempt — exactly the shape of the real race (head kept moving),
    // and rev-parse still works so each retry re-reads and re-parents.
    await fsp.mkdir(path.join(shadowDir, "refs", "sojourn"), { recursive: true });
    await fsp.writeFile(path.join(shadowDir, "refs", "sojourn", "head.lock"), "");

    try {
      const err = await snapshotter.snapshot().catch((e: unknown) => e);

      // Typed, so consumers can switch on `code` instead of substring-matching
      // the message — and still a real Error subclass, so generic catch sites
      // (daemon ingest's runSerialized) keep working unchanged.
      expect(err).toBeInstanceOf(SojournSnapshotError);
      expect(err).toBeInstanceOf(Error);
      const snapErr = err as SojournSnapshotError;
      expect(snapErr.name).toBe("SojournSnapshotError");
      expect(snapErr.code).toBe("cas_exhausted");
      expect(snapErr.attempts).toBe(5);

      // It names the tree that WAS computed (and is a real object in the
      // shadow repo) but never became reachable from refs/sojourn/head.
      expect(snapErr.treeHash).toMatch(/^[0-9a-f]{40}$/);
      expect(await snapshotter.hasTree(snapErr.treeHash)).toBe(true);
      expect(snapErr.message).toBe(
        `snapshot: refs/sojourn/head kept moving; gave up after 5 CAS attempts (tree ${snapErr.treeHash} was NOT recorded)`,
      );

      // ...genuinely NOT recorded: the head ref never came into existence.
      await expect(
        runGit(["rev-parse", "--verify", "refs/sojourn/head"], {
          GIT_DIR: shadowDir,
          GIT_WORK_TREE: projectRoot,
          GIT_INDEX_FILE: path.join(shadowDir, "verify-index"),
        }),
      ).rejects.toThrow();
    } finally {
      await fsp.rm(path.join(shadowDir, "refs", "sojourn", "head.lock"), { force: true });
    }
  });

  // ——— V2 must-fix C1: two roots sharing one shadow repo ————————————————
  //
  // Worktree-project aliasing (V2 Task 7) creates a SECOND snapshotter for
  // the same project id with a different projectRoot but the SAME shadowDir.
  // snapshot() must therefore (a) never share a mutable index file between
  // roots, and (b) append to refs/sojourn/head with a compare-and-swap so a
  // concurrent snapshot from the other root can never orphan a commit
  // (an orphaned commit's tree would be silently reaped by `soj gc`).
  describe("cross-root concurrency (shared shadowDir)", () => {
    let rootB: string;
    let snapshotterB: ShadowSnapshotter;

    beforeEach(async () => {
      rootB = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-project-b-"));
      snapshotterB = new ShadowSnapshotter({ projectRoot: rootB, shadowDir });
      await snapshotterB.init();
    });

    afterEach(() => {
      fs.rmSync(rootB, { recursive: true, force: true });
    });

    it("concurrent snapshot() calls from two roots each capture exactly their own root's files", async () => {
      // Several rounds: without a per-root index, the interleave
      // (A add -> B add -> A write-tree) makes A's tree list B's files.
      for (let round = 0; round < 5; round++) {
        await fsp.writeFile(path.join(projectRoot, "mainline.txt"), `mainline-${round}`);
        await fsp.writeFile(path.join(rootB, "branch.txt"), `branch-${round}`);

        const [treeA, treeB] = await Promise.all([
          snapshotter.snapshot(),
          snapshotterB.snapshot(),
        ]);

        expect((await snapshotter.listFiles(treeA)).sort()).toEqual(["mainline.txt"]);
        expect((await snapshotter.listFiles(treeB)).sort()).toEqual(["branch.txt"]);
        expect(await snapshotter.readFile(treeA, "mainline.txt")).toBe(`mainline-${round}`);
        expect(await snapshotter.readFile(treeB, "branch.txt")).toBe(`branch-${round}`);
      }
    });

    it("keeps EVERY concurrent snapshot's commit reachable from refs/sojourn/head (CAS append, no orphaned commits)", async () => {
      const expectedTrees = new Set<string>();
      for (let round = 0; round < 5; round++) {
        await fsp.writeFile(path.join(projectRoot, "mainline.txt"), `m-${round}`);
        await fsp.writeFile(path.join(rootB, "branch.txt"), `b-${round}`);
        const [treeA, treeB] = await Promise.all([
          snapshotter.snapshot(),
          snapshotterB.snapshot(),
        ]);
        expectedTrees.add(treeA);
        expectedTrees.add(treeB);
      }

      // Walk refs/sojourn/head: every snapshot's tree must be reachable —
      // a lost head update would leave that snapshot's commit orphaned and
      // therefore eligible for `soj gc` pruning while the graph still
      // advertises the node as restorable.
      const env = {
        GIT_DIR: shadowDir,
        GIT_WORK_TREE: projectRoot,
        GIT_INDEX_FILE: path.join(shadowDir, "unused-index"),
      };
      const out = await runGit(["log", "--format=%T", "refs/sojourn/head"], env);
      const reachableTrees = new Set(
        out
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      );
      for (const tree of expectedTrees) {
        expect(reachableTrees.has(tree)).toBe(true);
      }
    });
  });
});
