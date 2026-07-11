import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ShadowSnapshotter } from "../src/snapshot/shadowSnapshotter.js";
import { runGit, type ShadowGitEnv } from "../src/snapshot/git.js";
import { gcShadowRepo, collectPins } from "../src/snapshot/gc.js";
import { GraphStore } from "../src/store/index.js";
import type { ChronoNode, Flag } from "../src/types.js";

const execFileAsync = promisify(execFile);

const SOJOURN_HEAD_REF = "refs/sojourn/head";
const SOJOURN_SAFETY_REF = "refs/sojourn/safety";

describe("gcShadowRepo", () => {
  let projectRoot: string;
  let shadowDir: string;
  let env: ShadowGitEnv;
  let snapshotter: ShadowSnapshotter;
  let treeHashes: string[]; // index 0..5 <-> snapshots #1..#6, oldest -> newest
  let commitDates: number[]; // unix seconds, same order
  let nowSec: number;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-gc-project-"));
    shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-gc-shadow-"));
    snapshotter = new ShadowSnapshotter({ projectRoot, shadowDir });
    await snapshotter.init();

    env = {
      GIT_DIR: shadowDir,
      GIT_WORK_TREE: projectRoot,
      GIT_INDEX_FILE: path.join(shadowDir, "sojourn-index"),
    };

    nowSec = Math.floor(Date.now() / 1000);
    // #1,#2,#4 are old and unpinned -> prune candidates.
    // #3 is old but will be pinned (a flagged node's snapshot) -> kept.
    // #5,#6 are within any reasonable keepDays -> kept on recency alone.
    commitDates = [
      nowSec - 40 * 86400, // #1
      nowSec - 35 * 86400, // #2
      nowSec - 20 * 86400, // #3 (pinned in tests below)
      nowSec - 15 * 86400, // #4
      nowSec - 2 * 86400, // #5
      nowSec - 1 * 86400, // #6 (tip)
    ];

    treeHashes = [];
    let parent: string | null = null;
    for (let i = 0; i < 6; i++) {
      await fsp.writeFile(path.join(projectRoot, "state.txt"), `snapshot-${i + 1}`);
      await runGit(["add", "-A"], env);
      const tree = (await runGit(["write-tree"], env)).trim();
      const commitArgs = ["commit-tree", tree, "-m", `snap-${i + 1}`];
      if (parent) commitArgs.push("-p", parent);
      const commitEnv: ShadowGitEnv = {
        ...env,
        GIT_COMMITTER_DATE: `${commitDates[i]} +0000`,
        GIT_AUTHOR_DATE: `${commitDates[i]} +0000`,
      };
      const commit = (await runGit(commitArgs, commitEnv)).trim();
      await runGit(["update-ref", SOJOURN_HEAD_REF, commit], env);
      parent = commit;
      treeHashes.push(tree);
    }
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(shadowDir, { recursive: true, force: true });
  });

  function fixedNow(): () => Date {
    return () => new Date(nowSec * 1000);
  }

  async function currentRefs(): Promise<Record<string, string>> {
    const out = await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], env).catch(() => "");
    const map: Record<string, string> = {};
    for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [ref, sha] = line.split(" ");
      map[ref] = sha;
    }
    return map;
  }

  it("dry run reports pruning #1, #2, #4 only (pin #3, keepDays covers #5-6), mutating nothing", async () => {
    const pins = new Set([treeHashes[2]]);
    const before = await currentRefs();

    const result = await gcShadowRepo(
      { shadowDir },
      { keepDays: 3, pins, dryRun: true, now: fixedNow() },
    );

    expect(result.dryRun).toBe(true);
    expect(result.keptCommits).toBe(3); // #3, #5, #6
    expect(result.prunedCommits).toBe(3); // #1, #2, #4
    expect(result.archived).toBeNull();
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(0);

    const after = await currentRefs();
    expect(after).toEqual(before); // byte-identical refs after a dry run
  });

  it("dry run defaults to true when opts.dryRun is omitted", async () => {
    const pins = new Set([treeHashes[2]]);
    const before = await currentRefs();
    const result = await gcShadowRepo({ shadowDir }, { keepDays: 3, pins, now: fixedNow() });
    expect(result.dryRun).toBe(true);
    expect(await currentRefs()).toEqual(before);
  });

  it("--run prunes #1, #2, #4: their trees become unreachable; #3 (pinned), #5, #6 stay valid and restorable", async () => {
    const pins = new Set([treeHashes[2]]);

    const result = await gcShadowRepo(
      { shadowDir },
      { keepDays: 3, pins, dryRun: false, now: fixedNow() },
    );

    expect(result.dryRun).toBe(false);
    expect(result.keptCommits).toBe(3);
    expect(result.prunedCommits).toBe(3);

    for (const i of [0, 1, 3]) {
      expect(await snapshotter.hasTree(treeHashes[i])).toBe(false);
    }

    for (const i of [2, 4, 5]) {
      expect(await snapshotter.hasTree(treeHashes[i])).toBe(true);
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-gc-restore-"));
      try {
        await snapshotter.restoreToWorktree(treeHashes[i], dest);
        const content = await fsp.readFile(path.join(dest, "state.txt"), "utf8");
        expect(content).toBe(`snapshot-${i + 1}`);
      } finally {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
  });

  it("keeps refs/sojourn/head usable for future snapshots after a real prune", async () => {
    const pins = new Set([treeHashes[2]]);
    await gcShadowRepo({ shadowDir }, { keepDays: 3, pins, dryRun: false, now: fixedNow() });

    await fsp.writeFile(path.join(projectRoot, "state.txt"), "snapshot-7");
    const tree7 = await snapshotter.snapshot();
    expect(await snapshotter.hasTree(tree7)).toBe(true);
    const restored = await snapshotter.diff(treeHashes[5], tree7);
    expect(restored.some((c) => c.path === "state.txt")).toBe(true);
  });

  it("archives the pruned range BEFORE deleting: bundle exists and verifies", async () => {
    const pins = new Set([treeHashes[2]]);
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-gc-archive-"));
    try {
      const result = await gcShadowRepo(
        { shadowDir },
        { keepDays: 3, pins, dryRun: false, archiveDir, now: fixedNow() },
      );

      expect(result.archived).not.toBeNull();
      expect(fs.existsSync(result.archived!)).toBe(true);

      await execFileAsync("git", ["bundle", "verify", result.archived!], {
        env: { ...process.env, GIT_DIR: shadowDir },
      });
    } finally {
      fs.rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it("skips archiving when archiveDir is not given (archived stays null) but still prunes", async () => {
    const pins = new Set([treeHashes[2]]);
    const result = await gcShadowRepo(
      { shadowDir },
      { keepDays: 3, pins, dryRun: false, now: fixedNow() },
    );
    expect(result.archived).toBeNull();
    expect(await snapshotter.hasTree(treeHashes[0])).toBe(false);
  });

  it("never prunes anything reachable from refs/sojourn/safety, even if old and unpinned", async () => {
    await fsp.writeFile(path.join(projectRoot, "state.txt"), "safety-state");
    await runGit(["add", "-A"], env);
    const safetyTree = (await runGit(["write-tree"], env)).trim();
    const safetyDate = commitDates[0] - 100 * 86400; // far older than everything else
    const safetyEnv: ShadowGitEnv = {
      ...env,
      GIT_COMMITTER_DATE: `${safetyDate} +0000`,
      GIT_AUTHOR_DATE: `${safetyDate} +0000`,
    };
    const safetyCommit = (await runGit(["commit-tree", safetyTree, "-m", "safety"], safetyEnv)).trim();
    await runGit(["update-ref", SOJOURN_SAFETY_REF, safetyCommit], env);

    await gcShadowRepo({ shadowDir }, { keepDays: 3, pins: new Set(), dryRun: false, now: fixedNow() });

    expect(await snapshotter.hasTree(safetyTree)).toBe(true);
    // refs/sojourn/safety itself must be untouched by gc.
    const refs = await currentRefs();
    expect(refs[SOJOURN_SAFETY_REF]).toBe(safetyCommit);
  });

  it("is a total no-op (no ref rewrite, no archive) when nothing is prune-eligible", async () => {
    const pins = new Set(treeHashes); // everything pinned
    const before = await currentRefs();
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-gc-archive-noop-"));
    try {
      const result = await gcShadowRepo(
        { shadowDir },
        { keepDays: 3, pins, dryRun: false, archiveDir, now: fixedNow() },
      );
      expect(result.prunedCommits).toBe(0);
      expect(result.keptCommits).toBe(6);
      expect(result.archived).toBeNull();
      expect(await currentRefs()).toEqual(before);
      expect(fs.readdirSync(archiveDir)).toEqual([]);
    } finally {
      fs.rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it("a later run prunes a tree that was pinned before but isn't anymore, cleaning up its stale keep ref", async () => {
    // First run: keep #3 via an explicit pin, plus #5/#6 via recency.
    await gcShadowRepo(
      { shadowDir },
      { keepDays: 3, pins: new Set([treeHashes[2]]), dryRun: false, now: fixedNow() },
    );
    expect(await snapshotter.hasTree(treeHashes[2])).toBe(true);
    const afterFirst = await currentRefs();
    const keepRefsAfterFirst = Object.keys(afterFirst).filter((r) => r.startsWith("refs/sojourn/keep/"));
    expect(keepRefsAfterFirst.length).toBe(3); // #3, #5, #6

    // Second run: #3 is no longer pinned. Its ORIGINAL commit date was
    // preserved on the synthetic commit from run 1, so with the same
    // keepDays it now ages out and should actually get pruned this time.
    const result = await gcShadowRepo(
      { shadowDir },
      { keepDays: 3, pins: new Set(), dryRun: false, now: fixedNow() },
    );
    expect(result.prunedCommits).toBe(1);
    expect(result.keptCommits).toBe(2);
    expect(await snapshotter.hasTree(treeHashes[2])).toBe(false);
    expect(await snapshotter.hasTree(treeHashes[4])).toBe(true);
    expect(await snapshotter.hasTree(treeHashes[5])).toBe(true);

    const afterSecond = await currentRefs();
    const keepRefsAfterSecond = Object.keys(afterSecond).filter((r) => r.startsWith("refs/sojourn/keep/"));
    // The stale keep ref for the now-unpinned #3 must not just accumulate
    // alongside the new ones.
    expect(keepRefsAfterSecond.length).toBe(2);
  });

  it("returns an all-zero result for a freshly-initialized shadow repo with no snapshots yet", async () => {
    const emptyShadow = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-gc-empty-"));
    try {
      const emptySnapshotter = new ShadowSnapshotter({ projectRoot, shadowDir: emptyShadow });
      await emptySnapshotter.init();
      const result = await gcShadowRepo(
        { shadowDir: emptyShadow },
        { keepDays: 3, pins: new Set(), dryRun: true },
      );
      expect(result).toEqual({
        keptCommits: 0,
        prunedCommits: 0,
        reclaimedBytes: 0,
        archived: null,
        dryRun: true,
      });
    } finally {
      fs.rmSync(emptyShadow, { recursive: true, force: true });
    }
  });
});

describe("collectPins", () => {
  let store: GraphStore;
  const projectId = "proj-1";

  beforeEach(() => {
    store = new GraphStore(":memory:");
    store.upsertProject("/repo/proj-1", "Proj 1");
  });

  afterEach(() => {
    store.close();
  });

  function makeNode(overrides: Partial<ChronoNode> = {}): ChronoNode {
    const nativeUuid = overrides.meta?.nativeUuid ?? overrides.id ?? "uuid-1";
    return {
      id: overrides.id ?? `claude:${nativeUuid}`,
      parentId: null,
      kind: "assistant",
      cli: "claude",
      sessionId: "s1",
      projectId,
      timestamp: "2026-01-01T00:00:00.000Z",
      snapshotRef: null,
      label: null,
      summary: "",
      content: {},
      meta: { nativeUuid },
      ...overrides,
    };
  }

  const baseFlag: Flag = {
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence: "high",
    evidence: "claimed edit not found in diff",
    source: "deterministic",
  };

  it("pins snapshotRefs of decision/assumption/checkpoint nodes", () => {
    store.upsertNode(makeNode({ id: "claude:d1", kind: "decision", snapshotRef: "tree-decision" }));
    store.upsertNode(makeNode({ id: "claude:a1", kind: "assumption", snapshotRef: "tree-assumption" }));
    store.upsertNode(makeNode({ id: "claude:c1", kind: "checkpoint", snapshotRef: "tree-checkpoint" }));
    store.upsertNode(makeNode({ id: "claude:x1", kind: "assistant", snapshotRef: "tree-plain" }));

    const pins = collectPins(store, projectId);
    expect(pins).toEqual(new Set(["tree-decision", "tree-assumption", "tree-checkpoint"]));
  });

  it("pins snapshotRefs of nodes carrying any flag row (verified or advisory, dismissed or not)", () => {
    store.upsertNode(makeNode({ id: "claude:f1", kind: "assistant", snapshotRef: "tree-flagged" }));
    const flag = store.addFlag("claude:f1", baseFlag);
    store.dismissFlag(flag.id); // even a dismissed flag's evidence stays worth keeping

    store.upsertNode(makeNode({ id: "claude:u1", kind: "assistant", snapshotRef: "tree-unflagged" }));

    const pins = collectPins(store, projectId);
    expect(pins.has("tree-flagged")).toBe(true);
    expect(pins.has("tree-unflagged")).toBe(false);
  });

  it("merges caller-supplied extraPins (e.g. restore-manifest tree hashes) alongside store-derived pins", () => {
    store.upsertNode(makeNode({ id: "claude:d1", kind: "decision", snapshotRef: "tree-decision" }));
    store.upsertNode(makeNode({ id: "claude:x1", kind: "assistant", snapshotRef: "tree-plain" }));

    const pins = collectPins(store, projectId, new Set(["tree-from-manifest"]));
    expect(pins).toEqual(new Set(["tree-decision", "tree-from-manifest"]));
  });

  it("ignores nodes without a snapshotRef even if otherwise pin-worthy", () => {
    store.upsertNode(makeNode({ id: "claude:d1", kind: "decision", snapshotRef: null }));
    expect(collectPins(store, projectId).size).toBe(0);
  });

  it("only pins nodes belonging to the requested projectId", () => {
    store.upsertNode(
      makeNode({ id: "claude:other", kind: "decision", snapshotRef: "tree-other-project", projectId: "proj-2" }),
    );
    expect(collectPins(store, projectId).size).toBe(0);
    expect(collectPins(store, "proj-2").has("tree-other-project")).toBe(true);
  });
});
