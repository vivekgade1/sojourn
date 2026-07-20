import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GraphStore } from "../store/graphStore.js";
import { findEffectiveTree, findNearestCommonAncestor } from "../store/effectiveTree.js";
import type { SnapshotterLike } from "../interfaces.js";
import type {
  ChronoNode,
  CombineFileStatus,
  CombinePreflight,
  CombineResult,
  Project,
} from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Stable machine-readable classification for a `SojournCombineError`, set at
 * each throw site. Consumers (e.g. the daemon's HTTP layer) should switch on
 * this instead of substring-matching `message` — messages may be reworded
 * without changing behavior.
 *
 * Abort-clean guarantee: every code EXCEPT `write_failed` is raised before
 * the output worktree directory is claimed, so nothing whatsoever was
 * written. `write_failed` is the only partial state, and it carries
 * `.partial` naming the half-built worktree.
 */
export type SojournCombineErrorCode =
  | "not_found"
  | "cross_project"
  | "no_common_ancestor"
  | "no_tree"
  | "conflicts"
  | "read_failed"
  | "dest_exhausted"
  | "write_failed";

/** Honest mid-write state carried by `write_failed`: the worktree that was
 * claimed and partially populated, and which paths made it in. The directory
 * is deliberately NOT deleted — it holds real merged content, and combine's
 * whole purpose is to never be the source of data loss. */
export interface CombinePartialState {
  worktreePath: string;
  applied: string[];
  conflicted: string[];
  /** actionable paths NOT yet processed when the failure hit */
  remaining: string[];
}

export class SojournCombineError extends Error {
  readonly code: SojournCombineErrorCode;
  /** offending paths — conflicted files for "conflicts", the failing path
   * for "read_failed"/"write_failed"; empty for the node-level refusals */
  readonly files: string[];
  /** populated only for code "write_failed" */
  readonly partial: CombinePartialState | null;

  constructor(
    message: string,
    code: SojournCombineErrorCode,
    files: string[] = [],
    partial: CombinePartialState | null = null,
  ) {
    super(message);
    this.name = "SojournCombineError";
    this.code = code;
    this.files = files;
    this.partial = partial;
  }
}

/**
 * Internal signal: reading a path out of the base/A/B snapshot threw, or came
 * back null while the diff says that side HAS the path. Mirrors harvest's
 * ReadFailureSignal — a failed read must never be misread as "this side
 * deleted the file", which would silently drop content from the merge.
 * Caught at the classifyAll call site and converted to "read_failed" BEFORE
 * anything is written.
 */
class ReadFailureSignal extends Error {
  constructor(
    readonly relPath: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "ReadFailureSignal";
  }
}

export interface CombineDeps {
  store: GraphStore;
  /**
   * Returns a snapshotter for `project`. Base/A/B trees must all resolve in
   * the SAME shadow object database — which is why combine refuses two nodes
   * from different projects outright.
   */
  snapshotterFor(project: Project): SnapshotterLike;
  /** the same worktrees root `RestoreEngine` checks single-node restores into */
  worktreesDir: string;
  now?: () => Date;
}

export interface CombineOptions {
  /** write conflicted files WITH conflict markers instead of aborting */
  allowConflicts?: boolean;
}

/** Sojourn's own worktree artifacts — never merged, never classified. */
const ARTIFACT_PATHS = new Set<string>([".sojourn-restore.json", ".sojourn-harvest.patch"]);

const WARNING_FRESH_SESSION =
  "Combine produces FILES ONLY. No conversation transcript is synthesized — start a " +
  "genuinely fresh session in the output worktree; Sojourn will link it to node A automatically.";
const WARNING_NO_GIT =
  "Combine writes file contents into a NEW worktree only — it never touches your project or its .git.";

/** What the base->side diff says about a path on ONE side: "deleted" for
 * status D (or the old name of a rename), "present" otherwise. Cross-checked
 * against what we actually read, to catch a snapshotter that conflates a
 * failed read with an absent path. */
type SidePathStatus = "deleted" | "present";

// ——— content plumbing (binary-safe, Buffer end to end) ———

/** Byte-exact read of a tree file: `readFileRaw` when the snapshotter
 * provides it, utf8 `readFile` otherwise (NOT binary-safe — ShadowSnapshotter
 * always provides readFileRaw; the fallback exists only for minimal stubs). */
async function readTreeRaw(
  snap: SnapshotterLike,
  tree: string,
  rel: string,
): Promise<Buffer | null> {
  if (snap.readFileRaw) {
    return snap.readFileRaw(tree, rel);
  }
  const text = await snap.readFile(tree, rel);
  return text === null ? null : Buffer.from(text, "utf8");
}

function bufEq(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

/** git's own heuristic: a NUL byte in the first 8000 bytes means binary. */
function isBinary(buf: Buffer | null): boolean {
  return buf !== null && buf.subarray(0, 8000).includes(0);
}

function asText(buf: Buffer | null): string {
  return buf === null ? "" : buf.toString("utf8");
}

/**
 * Three-way merge via the system `git merge-file` over TEMP files only —
 * never git plumbing against the user's repo, and (unlike harvest) never
 * against a live worktree either: all three inputs come out of the shadow
 * object database. `-p` keeps it a pure dry-run (result on stdout, inputs
 * untouched). git merge-file exits with the number of conflicts, so a
 * positive exit code means "conflicted", not "errored".
 * TEXT ONLY — callers short-circuit binary content before reaching here.
 */
async function mergeFile(
  ours: string,
  base: string,
  theirs: string,
): Promise<{ conflicted: boolean; content: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sojourn-combine-"));
  try {
    const oursPath = path.join(dir, "ours");
    const basePath = path.join(dir, "base");
    const theirsPath = path.join(dir, "theirs");
    await Promise.all([
      fs.writeFile(oursPath, ours, "utf8"),
      fs.writeFile(basePath, base, "utf8"),
      fs.writeFile(theirsPath, theirs, "utf8"),
    ]);
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "merge-file", "-p",
          "-L", "node A", "-L", "common ancestor", "-L", "node B",
          oursPath, basePath, theirsPath,
        ],
        { cwd: dir, maxBuffer: 1024 * 1024 * 64 },
      );
      return { conflicted: false, content: stdout };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: unknown };
      if (typeof e.code === "number" && e.code > 0 && e.code <= 127 && typeof e.stdout === "string") {
        return { conflicted: true, content: e.stdout };
      }
      throw err;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

type FileAction =
  /** A already holds the merge outcome — the materialized A tree needs no edit */
  | { kind: "skip" }
  /** conflict that can never take text markers (binary): A's content stays */
  | { kind: "keep" }
  | { kind: "delete" }
  | { kind: "write"; content: Buffer };

interface ClassifiedFile {
  path: string;
  status: "clean" | "conflict" | "identical";
  action: FileAction;
}

/**
 * Classifies ONE path by three-way comparing base -> A ("ours") against
 * base -> B ("theirs").
 *
 * Unlike harvest's `classifyFile`, all three sides are TREES read from the
 * shadow object database — there is no live filesystem participant, so there
 * is no TOCTOU window, no destination-symlink hazard and no mainline-drift
 * check to make. The decision table is otherwise deliberately identical to
 * harvest's, so "clean"/"conflict"/"identical" mean exactly the same thing in
 * both features.
 */
async function classifyFile(
  snap: SnapshotterLike,
  baseTree: string,
  treeA: string,
  treeB: string,
  relPath: string,
  statusA: Map<string, SidePathStatus>,
  statusB: Map<string, SidePathStatus>,
): Promise<ClassifiedFile> {
  let baseBuf: Buffer | null;
  let aBuf: Buffer | null;
  let bBuf: Buffer | null;
  try {
    [baseBuf, aBuf, bBuf] = await Promise.all([
      readTreeRaw(snap, baseTree, relPath),
      readTreeRaw(snap, treeA, relPath),
      readTreeRaw(snap, treeB, relPath),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ReadFailureSignal(
      relPath,
      `reading this path from the base/A/B snapshots failed: ${msg}`,
    );
  }

  // A null buffer below is read as "that side deleted the file". If the diff
  // says the side HAS this path, a null read is a failure, not a deletion —
  // refuse rather than silently drop content out of the merge.
  if (aBuf === null && statusA.get(relPath) === "present") {
    throw new ReadFailureSignal(
      relPath,
      "the diff reports this path as present on node A, but reading its content returned nothing",
    );
  }
  if (bBuf === null && statusB.get(relPath) === "present") {
    throw new ReadFailureSignal(
      relPath,
      "the diff reports this path as present on node B, but reading its content returned nothing",
    );
  }

  // Both sides already agree (same bytes, or both deleted it): nothing to do.
  // A's materialized tree is already correct for this path.
  if (bufEq(aBuf, bBuf)) {
    return { path: relPath, status: "identical", action: { kind: "skip" } };
  }

  const aDiffersFromBase = !bufEq(aBuf, baseBuf);
  const bDiffersFromBase = !bufEq(bBuf, baseBuf);

  // B never moved — A's version already IS the merge outcome.
  if (!bDiffersFromBase) {
    return { path: relPath, status: "identical", action: { kind: "skip" } };
  }

  // `git merge-file` is text-only. Any binary participant short-circuits:
  // one-sided changes copy B's Buffer verbatim; anything needing a real
  // merge is a conflict — never merged, never markered.
  const binary = isBinary(baseBuf) || isBinary(aBuf) || isBinary(bBuf);

  if (bBuf === null) {
    // B deleted the file. (Both-deleted was the identical case above.)
    if (!aDiffersFromBase) {
      return { path: relPath, status: "clean", action: { kind: "delete" } };
    }
    if (binary) {
      return { path: relPath, status: "conflict", action: { kind: "keep" } };
    }
    // delete/modify: merge A's edit against whole-file deletion. An empty
    // clean resolution honors B's deletion; a non-empty one is a genuine
    // marker-less resolution and belongs in `applied`, not `conflicted`.
    const merged = await mergeFile(asText(aBuf), asText(baseBuf), "");
    if (!merged.conflicted) {
      return {
        path: relPath,
        status: "clean",
        action:
          merged.content === ""
            ? { kind: "delete" }
            : { kind: "write", content: Buffer.from(merged.content, "utf8") },
      };
    }
    // markers keep A's content visible rather than silently deleting it
    return {
      path: relPath,
      status: "conflict",
      action: { kind: "write", content: Buffer.from(merged.content, "utf8") },
    };
  }

  if (!aDiffersFromBase) {
    // A untouched since the common ancestor — B's bytes land verbatim
    // (binary-safe: Buffer end to end). Also covers files only B created.
    return { path: relPath, status: "clean", action: { kind: "write", content: bBuf } };
  }

  if (binary) {
    // Both sides moved on binary content — a text merge would corrupt it.
    return { path: relPath, status: "conflict", action: { kind: "keep" } };
  }

  // Both sides moved: real three-way merge. Empty stand-ins cover add/add
  // (no base) and A-deleted-while-B-modified (no ours) — both surface as
  // whole-file conflicts, never silent overwrites.
  const merged = await mergeFile(asText(aBuf), asText(baseBuf), asText(bBuf));
  return {
    path: relPath,
    status: merged.conflicted ? "conflict" : "clean",
    action: { kind: "write", content: Buffer.from(merged.content, "utf8") },
  };
}

/** Every path that differs between `baseTree` and `sideTree`, with renames
 * expanded into delete(oldPath) + add(newPath) so classification stays purely
 * content-driven, and Sojourn's own worktree artifacts filtered out. */
async function sideChanges(
  snap: SnapshotterLike,
  baseTree: string,
  sideTree: string,
): Promise<{ paths: string[]; status: Map<string, SidePathStatus> }> {
  const changes = await snap.diff(baseTree, sideTree);
  const paths: string[] = [];
  const status = new Map<string, SidePathStatus>();
  const seen = new Set<string>();
  const push = (p: string, s: SidePathStatus): void => {
    if (ARTIFACT_PATHS.has(p)) return;
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
    status.set(p, s);
  };
  for (const change of changes) {
    if (change.status === "R" && change.oldPath) {
      push(change.oldPath, "deleted");
      push(change.path, "present");
    } else if (change.status === "D") {
      push(change.path, "deleted");
    } else {
      push(change.path, "present");
    }
  }
  return { paths, status };
}

interface Resolved {
  nodeA: ChronoNode;
  nodeB: ChronoNode;
  base: ChronoNode;
  project: Project;
  snap: SnapshotterLike;
  baseTree: string;
  treeA: string;
  treeB: string;
  classified: ClassifiedFile[];
}

function nodeOrThrow(deps: CombineDeps, id: string, which: string): ChronoNode {
  const node = deps.store.getNode(id);
  if (!node) {
    throw new SojournCombineError(`Node ${which} not found: ${id}`, "not_found");
  }
  return node;
}

/**
 * Resolves both nodes, their merge base and all three trees, then classifies
 * every changed path. Shared verbatim by `combinePreflight` and `combine` so
 * the two can never disagree about what a combine would do.
 *
 * Reads only: the graph store and the shadow object database, plus temp dirs
 * under os.tmpdir() for `git merge-file` dry runs. Touches nothing under the
 * project root and nothing under `worktreesDir`.
 */
async function resolveAndClassify(
  deps: CombineDeps,
  nodeIdA: string,
  nodeIdB: string,
): Promise<Resolved> {
  const nodeA = nodeOrThrow(deps, nodeIdA, "A");
  const nodeB = nodeOrThrow(deps, nodeIdB, "B");

  // Base/A/B trees must all live in ONE shadow object database, and a merge
  // across unrelated projects is meaningless besides.
  if (nodeA.projectId !== nodeB.projectId) {
    throw new SojournCombineError(
      `Cannot combine nodes from different projects: ${nodeIdA} belongs to ${nodeA.projectId}, ` +
        `${nodeIdB} belongs to ${nodeB.projectId}.`,
      "cross_project",
    );
  }

  const project = deps.store.getProject(nodeA.projectId);
  if (!project) {
    throw new SojournCombineError(`Project not found: ${nodeA.projectId}`, "not_found");
  }

  const base = findNearestCommonAncestor(deps.store, nodeA, nodeB);
  if (!base) {
    throw new SojournCombineError(
      `Nodes ${nodeIdA} and ${nodeIdB} have no common ancestor — there is no shared state to ` +
        `merge against. Refusing to guess a merge base.`,
      "no_common_ancestor",
    );
  }

  const snap = deps.snapshotterFor(project);

  // Every side resolves through findEffectiveTree — the ONE shared
  // definition of "what tree does this node stand for" — so combine, restore
  // and gc's collectPins can never drift apart.
  const resolveTree = async (node: ChronoNode, which: string): Promise<string> => {
    const { treeHash } = findEffectiveTree(deps.store, node);
    if (treeHash === null) {
      throw new SojournCombineError(
        `Node ${which} (${node.id}) has no effective snapshot tree — neither it nor any ancestor ` +
          `carries a snapshotRef.`,
        "no_tree",
      );
    }
    if (!(await snap.hasTree(treeHash))) {
      throw new SojournCombineError(
        `Tree ${treeHash} for node ${which} (${node.id}) is not present in the shadow snapshot repo.`,
        "no_tree",
      );
    }
    return treeHash;
  };

  const baseTree = await resolveTree(base, "base");
  const treeA = await resolveTree(nodeA, "A");
  const treeB = await resolveTree(nodeB, "B");

  const [sideA, sideB] = await Promise.all([
    sideChanges(snap, baseTree, treeA),
    sideChanges(snap, baseTree, treeB),
  ]);

  // Only paths B actually moved can require any edit to A's materialized
  // tree; paths A alone touched are already correct there by construction.
  const paths = sideB.paths;

  const classified: ClassifiedFile[] = [];
  try {
    for (const p of paths) {
      classified.push(
        await classifyFile(snap, baseTree, treeA, treeB, p, sideA.status, sideB.status),
      );
    }
  } catch (err) {
    if (err instanceof ReadFailureSignal) {
      throw new SojournCombineError(
        `Combine aborted: reading "${err.relPath}" from the snapshots failed — ${err.reason}. ` +
          `Nothing was written.`,
        "read_failed",
        [err.relPath],
      );
    }
    throw err;
  }

  return { nodeA, nodeB, base, project, snap, baseTree, treeA, treeB, classified };
}

function toFileStatuses(classified: ClassifiedFile[]): CombineFileStatus[] {
  return classified.map((c) => ({
    path: c.path,
    status: c.status,
    ...(c.status === "conflict" && c.action.kind === "keep" ? { unmarkable: true } : {}),
  }));
}

function buildWarnings(classified: ClassifiedFile[]): string[] {
  const warnings: string[] = [];
  const conflicts = classified.filter((c) => c.status === "conflict").map((c) => c.path);
  if (conflicts.length > 0) {
    warnings.push(
      `Conflicted files (require allowConflicts or manual resolution): ${conflicts.join(", ")}`,
    );
  }
  const unmarkable = classified
    .filter((c) => c.status === "conflict" && c.action.kind === "keep")
    .map((c) => c.path);
  if (unmarkable.length > 0) {
    warnings.push(
      `${unmarkable.length} conflicted file(s) cannot take text conflict markers (binary content) ` +
        `and will keep node A's version verbatim: ${unmarkable.join(", ")}`,
    );
  }
  warnings.push(WARNING_FRESH_SESSION);
  warnings.push(WARNING_NO_GIT);
  return warnings;
}

/**
 * Reports exactly what `combine` would do, without doing it.
 *
 * PURITY: unlike `harvestPreflight` — which snapshots the live worktree and
 * therefore does mutate the shadow repo — this is genuinely side-effect-free
 * with respect to both the user's project AND the shadow object database:
 * base/A/B are pre-existing trees, so nothing is snapshotted, nothing is
 * written under `worktreesDir`, and no graph node is inserted. The only
 * filesystem activity is short-lived temp directories under os.tmpdir()
 * feeding `git merge-file -p` dry runs, all removed before returning.
 */
export async function combinePreflight(
  deps: CombineDeps,
  nodeIdA: string,
  nodeIdB: string,
): Promise<CombinePreflight> {
  const r = await resolveAndClassify(deps, nodeIdA, nodeIdB);
  return {
    nodeIdA: r.nodeA.id,
    nodeIdB: r.nodeB.id,
    baseNodeId: r.base.id,
    baseTree: r.baseTree,
    treeA: r.treeA,
    treeB: r.treeB,
    files: toFileStatuses(r.classified),
    warnings: buildWarnings(r.classified),
  };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatTimestamp(d: Date): string {
  return (
    d.getFullYear().toString().padStart(4, "0") +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

function short(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

const MAX_DEST_CREATE_ATTEMPTS = 5;

/**
 * Claims a not-yet-existing output worktree directory, uniquifying with a
 * short random suffix on collision. Mirrors `RestoreEngine`'s `claimDest`:
 * strict (non-recursive) mkdir of the leaf so an existing directory raises
 * EEXIST rather than being silently reused and merged into.
 */
async function claimDest(baseDest: string): Promise<string> {
  await fs.mkdir(path.dirname(baseDest), { recursive: true });
  let candidate = baseDest;
  for (let attempt = 0; attempt < MAX_DEST_CREATE_ATTEMPTS; attempt++) {
    try {
      await fs.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      candidate = `${baseDest}-${crypto.randomBytes(1).toString("hex")}`;
    }
  }
  throw new SojournCombineError(
    `Could not claim a unique worktree directory for ${baseDest} after ${MAX_DEST_CREATE_ATTEMPTS} attempts.`,
    "dest_exhausted",
  );
}

/** Resolves `rel` under `root`, refusing anything that would escape it. */
function resolveWithin(root: string, rel: string): string {
  const normRoot = path.resolve(root);
  const dest = path.resolve(normRoot, rel);
  if (dest !== normRoot && !dest.startsWith(normRoot + path.sep)) {
    throw new Error(`Refusing to write outside the combine worktree: ${rel}`);
  }
  return dest;
}

/** tmp file + rename inside the destination's real parent directory, so a
 * failure mid-write never leaves a torn file. The destination is a worktree
 * we just created and populated ourselves, so there is no foreign-symlink
 * hazard here — but the containment check stays as defense in depth. */
async function atomicWrite(root: string, rel: string, content: Buffer): Promise<void> {
  const dest = resolveWithin(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const realParent = await fs.realpath(path.dirname(dest));
  const realRoot = await fs.realpath(root);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
    throw new Error(`Resolved parent directory escapes the combine worktree: ${rel}`);
  }
  const tmp = path.join(realParent, `.sojourn-combine-tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, path.join(realParent, path.basename(dest)));
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Three-way merges node A's and node B's FILE STATES against their nearest
 * common ancestor and materializes the result into a NEW worktree.
 *
 * A is "ours" and supplies the worktree's starting content; B's changes are
 * merged on top. Nothing outside `worktreesDir` is ever written — the user's
 * project and both source snapshots are strictly read-only inputs.
 *
 * NO TRANSCRIPT IS SYNTHESIZED. Combine produces files, full stop. The user
 * starts a real, fresh session in the returned worktree, and the existing
 * worktree-aliasing path gives that session its own `meta.forkedFrom` edge.
 * Fabricating a merged conversation is forbidden: a transcript we cannot
 * faithfully reconstruct must never be invented.
 */
export async function combine(
  deps: CombineDeps,
  nodeIdA: string,
  nodeIdB: string,
  opts: CombineOptions = {},
): Promise<CombineResult> {
  const r = await resolveAndClassify(deps, nodeIdA, nodeIdB);

  const conflictPaths = r.classified.filter((c) => c.status === "conflict").map((c) => c.path);
  if (conflictPaths.length > 0 && opts.allowConflicts !== true) {
    // ABORT CLEAN: every classification above was a dry run over temp files
    // and no output directory has been claimed yet, so ZERO files exist.
    throw new SojournCombineError(
      `Combine aborted: ${conflictPaths.length} conflicted file(s): ${conflictPaths.join(", ")}. ` +
        `No worktree was created and nothing was written. Re-run with allowConflicts to write ` +
        `conflict markers.`,
      "conflicts",
      conflictPaths,
    );
  }

  const now = deps.now ?? (() => new Date());
  const stamp = formatTimestamp(now());
  const baseDest = path.join(
    deps.worktreesDir,
    r.nodeA.projectId,
    `combine-${short(r.nodeA.id)}-${short(r.nodeB.id)}-${stamp}`,
  );
  const dest = await claimDest(baseDest);

  // A's tree IS the starting point; only B's side needs applying on top.
  await r.snap.restoreToWorktree(r.treeA, dest);

  const applied: string[] = [];
  const conflicted: string[] = [];
  const unmarkable: string[] = [];
  const skippedIdentical: string[] = [];
  const warnings: string[] = [];

  const queue: ClassifiedFile[] = [];
  for (const c of r.classified) {
    if (c.action.kind === "skip") skippedIdentical.push(c.path);
    else queue.push(c);
  }

  let cursor = 0;
  try {
    for (; cursor < queue.length; cursor++) {
      const c = queue[cursor];
      if (c.action.kind === "keep") {
        // Binary conflict: reported, A's materialized content left as-is.
        conflicted.push(c.path);
        unmarkable.push(c.path);
        continue;
      }
      if (c.action.kind === "delete") {
        await fs.rm(resolveWithin(dest, c.path), { force: true });
        applied.push(c.path);
      } else if (c.action.kind === "write") {
        await atomicWrite(dest, c.path, c.action.content);
        if (c.status === "conflict") conflicted.push(c.path);
        else applied.push(c.path);
      }
      // ("skip" never reaches the queue — filtered into skippedIdentical above)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failedPath = queue[cursor]?.path ?? "(unknown)";
    throw new SojournCombineError(
      `Combine failed while populating ${dest} at ${failedPath}: ${msg}. The partially built ` +
        `worktree was left in place (it contains real merged content); already-written and ` +
        `remaining paths are recorded on this error (.partial).`,
      "write_failed",
      [failedPath],
      {
        worktreePath: dest,
        applied: [...applied],
        conflicted: [...conflicted],
        remaining: queue.slice(cursor).map((c) => c.path),
      },
    );
  }

  if (unmarkable.length > 0) {
    warnings.push(
      `${unmarkable.length} conflicted file(s) cannot take text conflict markers (binary content) ` +
        `and kept node A's version verbatim: ${unmarkable.join(", ")}`,
    );
  }
  warnings.push(WARNING_FRESH_SESSION);
  warnings.push(WARNING_NO_GIT);

  // MANIFEST CONTRACT: `nodeId` must stay a plain string naming node A.
  // The daemon's readRestoreManifest keys worktree->project aliasing and
  // harvest-back off exactly that field, so keeping it unchanged means both
  // keep working with zero changes elsewhere. Combine provenance rides
  // along in ADDITIONAL keys that older readers simply ignore.
  const manifest = {
    nodeId: r.nodeA.id,
    treeHash: r.treeA,
    combinedWith: r.nodeB.id,
    baseNodeId: r.base.id,
    baseTree: r.baseTree,
    treeA: r.treeA,
    treeB: r.treeB,
    combinedAt: now().toISOString(),
  };
  await fs.writeFile(
    path.join(dest, ".sojourn-restore.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  // The merged files already exist at this point — a graph bookkeeping
  // failure must never turn a successful combine into a rejection.
  let combineNodeId: string | null = null;
  try {
    combineNodeId = insertCombineNode(deps, r, {
      worktreePath: dest,
      applied,
      conflicted,
      unmarkable,
      skippedIdentical,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(
      `Combine succeeded, but recording the combine node in the graph failed: ${msg}`,
    );
  }

  return {
    worktreePath: dest,
    nodeIdA: r.nodeA.id,
    nodeIdB: r.nodeB.id,
    baseNodeId: r.base.id,
    baseTree: r.baseTree,
    treeA: r.treeA,
    treeB: r.treeB,
    applied,
    conflicted,
    unmarkable,
    skippedIdentical,
    combineNodeId,
    warnings,
  };
}

interface CombineNodeInfo {
  worktreePath: string;
  applied: string[];
  conflicted: string[];
  unmarkable: string[];
  skippedIdentical: string[];
}

/**
 * Graph closure: a checkpoint node parented to node A, recording node B as
 * `meta.mergedFrom` provenance. Modeled on harvest's `insertMergeNode`,
 * including its guards — skipped (null) when no store is reachable, when A is
 * unknown to it (we never fabricate project/session identity), or when the
 * combine wrote no files at all (an all-identical combine is not a merge).
 *
 * `snapshotRef` is deliberately null: this node stands for a merge that
 * happened in a scratch worktree, not for a captured project state, so its
 * effective tree resolves through A exactly like any /api/mark node.
 */
function insertCombineNode(
  deps: CombineDeps,
  r: Resolved,
  info: CombineNodeInfo,
): string | null {
  const store = deps.store;
  if (!store) return null;

  const fileCount = info.applied.length + info.conflicted.length;
  if (fileCount === 0) return null;

  const origin = store.getNode(r.nodeA.id);
  if (!origin) return null;

  const now = (deps.now ?? (() => new Date()))();
  const label = `combine: ${fileCount} ${fileCount === 1 ? "file" : "files"} from ${short(r.nodeB.id)}`;
  const nativeUuid = `combine-${crypto.randomUUID()}`;

  const node: ChronoNode = {
    id: `${origin.cli}:${nativeUuid}`,
    parentId: origin.id,
    kind: "checkpoint",
    cli: origin.cli,
    sessionId: origin.sessionId,
    projectId: origin.projectId,
    timestamp: now.toISOString(),
    snapshotRef: null,
    label,
    summary: label,
    content: {
      worktreePath: info.worktreePath,
      baseNodeId: r.base.id,
      baseTree: r.baseTree,
      nodeIdA: r.nodeA.id,
      nodeIdB: r.nodeB.id,
      treeA: r.treeA,
      treeB: r.treeB,
      applied: info.applied,
      conflicted: info.conflicted,
      unmarkable: info.unmarkable,
      skippedIdentical: info.skippedIdentical,
    },
    meta: { nativeUuid, mergedFrom: r.nodeB.id },
  };

  store.upsertNode(node);
  return node.id;
}
