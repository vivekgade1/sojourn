import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { GraphStore } from "../store/index.js";
import { runGit, type ShadowGitEnv } from "./git.js";

const execFileAsync = promisify(execFile);

const SOJOURN_HEAD_REF = "refs/sojourn/head";
const SOJOURN_SAFETY_REF = "refs/sojourn/safety";
const SOJOURN_KEEP_PREFIX = "refs/sojourn/keep/";

// ——— collectPins ———————————————————————————————————————————————

const PINNED_NODE_KINDS = new Set(["decision", "assumption", "checkpoint"]);

/**
 * Pure store reads: the set of snapshot tree hashes GC must never prune.
 *
 * Protects:
 *  - nodes whose kind is decision / assumption / checkpoint (the graph's
 *    named waypoints — a user explicitly marked these as worth returning to)
 *  - any node carrying at least one flag row, dismissed or not, verified or
 *    advisory (evidence worth being able to re-examine)
 *  - whatever the caller already knows must survive (`extraPins`) — e.g.
 *    tree hashes read out of `.sojourn-restore.json` manifests for live
 *    worktrees. This function does no filesystem I/O itself; the manifest
 *    scan is the caller's job (daemon/CLI own the worktrees directory, not
 *    the store).
 */
export function collectPins(
  store: GraphStore,
  projectId: string,
  extraPins: Set<string> = new Set(),
): Set<string> {
  const pins = new Set<string>(extraPins);
  for (const node of store.getGraph(projectId)) {
    if (node.snapshotRef === null) continue;
    const isPinnedKind = PINNED_NODE_KINDS.has(node.kind);
    const hasFlags = (node.flags?.length ?? 0) > 0;
    if (isPinnedKind || hasFlags) pins.add(node.snapshotRef);
  }
  return pins;
}

// ——— gcShadowRepo ———————————————————————————————————————————————

export interface GcTarget {
  /** Absolute path to the shadow repo's GIT_DIR — the same value passed as
   * `shadowDir` to `ShadowSnapshotterOptions`. GC only ever touches this
   * directory; it never receives (or needs) the project's real working
   * tree or `.git`. */
  shadowDir: string;
}

export interface GcOptions {
  /** Commits whose committer date is younger than this many days are always
   * kept, regardless of pins. */
  keepDays: number;
  /** Tree hashes to always keep, regardless of age — see `collectPins`. */
  pins: Set<string>;
  /** Defaults to true: gcShadowRepo never mutates anything unless the
   * caller opts in explicitly. */
  dryRun?: boolean;
  /** When set, a full bundle backup of everything reachable from
   * refs/sojourn/head (and refs/sojourn/safety, if present) is written here
   * BEFORE any ref is rewritten or object is pruned. Skipped on dry runs. */
  archiveDir?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Test-only hook, invoked on real (non-dry) runs immediately before the
   * final compare-and-swap head repoint — lets tests deterministically land
   * a concurrent write inside the race window. Never set in production. */
  onBeforeFinalize?: () => Promise<void>;
}

export interface GcResult {
  keptCommits: number;
  prunedCommits: number;
  /** Bytes reclaimed on disk. For a real run this is an exact
   * du-before/du-after measurement of shadowDir — note that the figure
   * therefore also includes `git gc`'s repack/recompression savings, not
   * just the pruned snapshots' own data. For a dry run it is an estimate:
   * the on-disk size of objects reachable ONLY from commits that would be
   * pruned (i.e. not shared with anything kept). */
  reclaimedBytes: number;
  /** Path to the pre-prune backup bundle, or null when archiveDir was not
   * given, there was nothing to prune, or this was a dry run. */
  archived: string | null;
  dryRun: boolean;
  /** Set (only) when a real run detected that refs/sojourn/head moved while
   * gc was working — i.e. a concurrently-running daemon landed a new
   * snapshot. The whole mutating tail was aborted BEFORE any reflog expire
   * or `git gc`: nothing was pruned, the concurrent snapshot is untouched,
   * and a later re-run will complete the job. (A backup bundle written
   * before the abort, if any, is left in place — `archived` still reports
   * it.) */
  aborted?: "concurrent_write";
}

interface ChainEntry {
  hash: string;
  treeHash: string;
  timeSec: number;
}

function buildEnv(shadowDir: string): ShadowGitEnv {
  // No command gcShadowRepo runs touches the working tree or the index
  // (commit-tree/update-ref/log/for-each-ref/reflog/gc/bundle/cat-file all
  // operate purely on the object database and refs), so GIT_WORK_TREE and
  // GIT_INDEX_FILE are never actually read — they're set anyway to satisfy
  // ShadowGitEnv's shape and to keep this function's git invocations pinned
  // to the shadow repo exactly like the snapshotter, never a real project.
  return {
    GIT_DIR: shadowDir,
    GIT_WORK_TREE: shadowDir,
    GIT_INDEX_FILE: path.join(shadowDir, "sojourn-gc-index"),
  };
}

async function revParseOrNull(env: ShadowGitEnv, ref: string): Promise<string | null> {
  try {
    return (await runGit(["rev-parse", "--verify", ref], env)).trim();
  } catch {
    return null;
  }
}

/** Oldest → newest walk of the (always-linear, single-parent) chain ending
 * at `tip`. */
async function listChain(env: ShadowGitEnv, tip: string): Promise<ChainEntry[]> {
  const out = await runGit(
    ["log", "--format=%H%x1f%T%x1f%ct", "--date-order", "--reverse", tip],
    env,
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const [hash, treeHash, timeSec] = line.split("\x1f");
      return { hash, treeHash, timeSec: Number.parseInt(timeSec, 10) };
    });
}

async function duBytes(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", dir]);
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

/** Sums the on-disk size of each object hash via `git cat-file
 * --batch-check`, fed over stdin (there is no argument form for
 * --batch-check). */
async function batchObjectSizes(env: ShadowGitEnv, hashes: string[]): Promise<number> {
  if (hashes.length === 0) return 0;
  return new Promise<number>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch-check=%(objectsize:disk)"], {
      env: { ...process.env, ...env },
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (errOut += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file --batch-check failed (exit ${code}): ${errOut}`));
        return;
      }
      const total = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))
        .reduce((sum, line) => sum + Number.parseInt(line, 10), 0);
      resolve(total);
    });
    child.stdin.write(hashes.join("\n") + "\n");
    child.stdin.end();
  });
}

/** Estimates bytes reclaimable by pruning `prunedHashes`: the size of
 * objects reachable from those commits but NOT reachable from anything
 * being kept (`keptHashes` union the safety ref, when present). Read-only —
 * `rev-list`/`cat-file --batch-check` never mutate the repo. */
async function estimatePrunedBytes(
  env: ShadowGitEnv,
  prunedHashes: string[],
  keptHashes: string[],
  hasSafetyRef: boolean,
): Promise<number> {
  if (prunedHashes.length === 0) return 0;
  const args = ["rev-list", "--objects", ...prunedHashes, "--not", ...keptHashes];
  if (hasSafetyRef) args.push(SOJOURN_SAFETY_REF);
  const out = await runGit(args, env);
  const objectHashes = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(" ")[0]);
  return batchObjectSizes(env, objectHashes);
}

async function deleteExistingKeepRefs(env: ShadowGitEnv): Promise<void> {
  const out = await runGit(
    ["for-each-ref", "--format=%(refname)", SOJOURN_KEEP_PREFIX],
    env,
  ).catch(() => "");
  const refs = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const ref of refs) {
    await runGit(["update-ref", "-d", ref], env);
  }
}

/**
 * Retention GC for a project's shadow snapshot repo — SHADOW repo env only
 * (GIT_DIR isolation exactly like ShadowSnapshotter; this never touches a
 * real project's .git). Walks refs/sojourn/head's history; a commit is KEPT
 * when it is younger than `opts.keepDays`, OR its tree is in `opts.pins`,
 * OR its tree also appears in refs/sojourn/safety's history. Everything
 * else is a prune candidate.
 *
 * Because the head chain is a straight (single-parent) line, "pruning" an
 * old commit while an old-but-kept commit sits on top of it would otherwise
 * still drag the pruned commit in as a reachable ancestor. So kept commits
 * are rebuilt into a new squashed chain (same trees, new synthetic parent
 * pointers that skip over pruned gaps), each one ALSO getting its own
 * `refs/sojourn/keep/<i>` ref so it stays individually reachable even if
 * refs/sojourn/head later moves on. Only after that rebuild — and, when
 * `archiveDir` is set, only after a full pre-prune backup bundle is written
 * — do old objects actually get removed, via `reflog expire --expire=now`
 * (drop the safety net the ref update itself would otherwise leave behind)
 * followed by `gc --prune=5.minutes.ago` (the grace window preserves loose
 * objects a concurrent writer may have created moments ago).
 *
 * Concurrency: a daemon may be capturing snapshots into this same shadow
 * repo while gc runs. The final head repoint is therefore a compare-and-swap
 * against the tip read at the start (`update-ref <ref> <new> <expected-old>`).
 * If refs/sojourn/head moved in the window — the daemon landed a snapshot —
 * the ENTIRE mutating tail aborts BEFORE any reflog expire or `git gc`:
 * nothing is pruned, the daemon's snapshot stays head, and the result
 * carries `aborted: "concurrent_write"` so callers can tell the user to
 * simply re-run later. (An archive bundle already written is left in place.)
 *
 * `dryRun` (default true) computes and returns the identical result shape
 * WITHOUT writing a single object or moving a single ref — every mutating
 * step below is gated behind `!dryRun`.
 */
export async function gcShadowRepo(target: GcTarget, opts: GcOptions): Promise<GcResult> {
  const env = buildEnv(target.shadowDir);
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ? opts.now() : new Date();
  const cutoffSec = Math.floor(now.getTime() / 1000) - opts.keepDays * 86400;

  const headTip = await revParseOrNull(env, SOJOURN_HEAD_REF);
  if (!headTip) {
    return { keptCommits: 0, prunedCommits: 0, reclaimedBytes: 0, archived: null, dryRun };
  }

  const chain = await listChain(env, headTip); // oldest -> newest

  const safetyTip = await revParseOrNull(env, SOJOURN_SAFETY_REF);
  const hasSafetyRef = safetyTip !== null;
  const safetyTrees = safetyTip
    ? new Set((await listChain(env, safetyTip)).map((c) => c.treeHash))
    : new Set<string>();

  const keepers: ChainEntry[] = [];
  const pruned: ChainEntry[] = [];
  for (const c of chain) {
    const protectedByTree = opts.pins.has(c.treeHash) || safetyTrees.has(c.treeHash);
    const recent = c.timeSec >= cutoffSec;
    if (protectedByTree || recent) keepers.push(c);
    else pruned.push(c);
  }

  if (pruned.length === 0) {
    // Nothing to do — stay a total no-op (no ref rewrite, no archive) even
    // on a real run, since there's nothing to protect against.
    return { keptCommits: keepers.length, prunedCommits: 0, reclaimedBytes: 0, archived: null, dryRun };
  }

  if (dryRun) {
    const reclaimedBytes = await estimatePrunedBytes(
      env,
      pruned.map((c) => c.hash),
      keepers.map((c) => c.hash),
      hasSafetyRef,
    );
    return { keptCommits: keepers.length, prunedCommits: pruned.length, reclaimedBytes, archived: null, dryRun };
  }

  // ———————————————————————— real run: mutate ————————————————————————

  const duBefore = await duBytes(target.shadowDir);

  let archived: string | null = null;
  if (opts.archiveDir) {
    await fs.mkdir(opts.archiveDir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const bundlePath = path.join(opts.archiveDir, `pruned-${stamp}.bundle`);
    const bundleArgs = ["bundle", "create", bundlePath, SOJOURN_HEAD_REF];
    if (hasSafetyRef) bundleArgs.push(SOJOURN_SAFETY_REF);
    await runGit(bundleArgs, env);
    archived = bundlePath;
  }

  // Drop any keep refs from a previous gc run before writing fresh ones —
  // otherwise a tree that WAS pinned before but isn't anymore would stay
  // artificially reachable forever.
  await deleteExistingKeepRefs(env);

  let parent: string | null = null;
  for (let i = 0; i < keepers.length; i++) {
    const c = keepers[i];
    const args = ["commit-tree", c.treeHash];
    if (parent) args.push("-p", parent);
    args.push("-m", `sojourn-gc keep: originally ${c.hash.slice(0, 12)}`);
    const commitEnv: ShadowGitEnv = {
      ...env,
      // Preserve the ORIGINAL commit time on the synthetic commit so a
      // later gc run's age check still reflects when the snapshot actually
      // happened, not when it was last rebuilt.
      GIT_COMMITTER_DATE: `${c.timeSec} +0000`,
      GIT_AUTHOR_DATE: `${c.timeSec} +0000`,
    };
    const sha = (await runGit(args, commitEnv)).trim();
    parent = sha;
    await runGit(["update-ref", `${SOJOURN_KEEP_PREFIX}${i}`, sha], env);
  }

  // Test-only hook: opens a deterministic window for tests to land a
  // concurrent snapshot between the keeper rebuild and the CAS below.
  if (opts.onBeforeFinalize) await opts.onBeforeFinalize();

  // Final head repoint is a compare-and-swap: the 3-arg update-ref form
  // (and the delete form with an expected old value) only succeeds while
  // refs/sojourn/head still equals the tip read at the start. If a
  // concurrently-running daemon landed a snapshot in the window, ABORT the
  // whole mutating tail here — before any reflog expire / gc — so the
  // daemon's snapshot is neither clobbered nor at risk of being reaped.
  try {
    if (parent) {
      await runGit(["update-ref", SOJOURN_HEAD_REF, parent, headTip], env);
    } else {
      // Nothing survived retention at all — leave no head rather than point
      // it at a lie; the next snapshot() call starts a fresh chain.
      await runGit(["update-ref", "-d", SOJOURN_HEAD_REF, headTip], env);
    }
  } catch (err) {
    const headNow = await revParseOrNull(env, SOJOURN_HEAD_REF);
    if (headNow !== headTip) {
      // Head moved under us: concurrent write. Nothing has been pruned (the
      // bundle, keep refs, and synthetic keeper commits only ADD data), so
      // aborting here is clean; a later re-run completes the job.
      return {
        keptCommits: keepers.length,
        prunedCommits: 0,
        reclaimedBytes: 0,
        archived,
        dryRun,
        aborted: "concurrent_write",
      };
    }
    throw err;
  }

  await runGit(["reflog", "expire", "--expire=now", "--all"], env);
  // --prune=5.minutes.ago, NOT --prune=now: git's default grace protects
  // loose objects created in the last few minutes, which is exactly what a
  // concurrent writer's in-flight objects look like. Unreachable objects
  // still get removed — just on the next gc after the grace elapses.
  await runGit(["gc", "--prune=5.minutes.ago"], env);

  const duAfter = await duBytes(target.shadowDir);
  const reclaimedBytes = Math.max(0, duBefore - duAfter);

  return { keptCommits: keepers.length, prunedCommits: pruned.length, reclaimedBytes, archived, dryRun };
}
