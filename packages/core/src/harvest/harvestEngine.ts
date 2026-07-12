import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SnapshotterLike } from "../interfaces.js";
import type { ChronoNode, HarvestPreflight, HarvestResult } from "../types.js";

const execFileAsync = promisify(execFile);

/** Stable machine-readable classification for a `SojournHarvestError`,
 * set at each throw site. Consumers (e.g. the daemon's HTTP layer) should
 * switch on this instead of substring-matching `message`. */
export type SojournHarvestErrorCode =
  | "no_manifest"
  | "stale_base"
  | "conflicts"
  | "partial_apply"
  | "mainline_drift"
  | "patch_incomplete"
  | "read_failed";

/** Honest mid-apply state carried by "partial_apply" / "mainline_drift":
 * exactly which files landed before the failure, which never will, and the
 * safety snapshot that holds the full pre-harvest mainline. */
export interface HarvestPartialState {
  applied: string[];
  conflicted: string[];
  /** actionable paths NOT yet processed when the failure hit (includes the failing path) */
  remaining: string[];
  safetySnapshotRef: string;
}

export class SojournHarvestError extends Error {
  readonly code: SojournHarvestErrorCode;
  /** offending file paths — conflicted files for "conflicts", the failing
   * path for "partial_apply"/"mainline_drift"/"patch_incomplete" */
  readonly files: string[];
  /** populated only for codes "partial_apply" and "mainline_drift" */
  readonly partial: HarvestPartialState | null;

  constructor(
    message: string,
    code: SojournHarvestErrorCode,
    files: string[] = [],
    partial: HarvestPartialState | null = null,
  ) {
    super(message);
    this.name = "SojournHarvestError";
    this.code = code;
    this.files = files;
    this.partial = partial;
  }
}

/** Internal signal: the mainline moved between classification and write. */
class DriftSignal extends Error {
  constructor(
    readonly relPath: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "DriftSignal";
  }
}

/**
 * Internal signal: reading a path's content out of the branch snapshot
 * either threw, or came back null while the diff itself says the branch has
 * this path (status A/M, or the new side of a rename) — never "D". Thrown
 * from classifyFile, caught at the classifyAll call sites in
 * harvestPreflight/harvest and converted into a typed SojournHarvestError
 * ("read_failed") BEFORE any mainline write happens.
 *
 * This is defense in depth on top of the snapshotter-level fix (see
 * shadowSnapshotter.ts GIT_PATH_ABSENT_RE): even a SnapshotterLike
 * implementation that conflates "read failed" with "path absent" cannot
 * make classifyFile treat a large-file read failure as "the branch deleted
 * this file" and silently delete the mainline's copy.
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

/** Minimal slice of GraphStore that harvest needs for graph closure. */
export interface HarvestStoreLike {
  getNode(id: string): ChronoNode | null;
  upsertNode(node: ChronoNode): void;
}

export interface HarvestDeps {
  /**
   * Returns a snapshotter whose work tree is `root` but whose shadow repo is
   * the SAME shadow git dir as the mainline project — base/branch trees and
   * the mainline safety snapshot must all live in one object database.
   */
  snapshotterForRoot(root: string): SnapshotterLike;
  /** When provided, a successful apply inserts a checkpoint node closing the fork. */
  store?: HarvestStoreLike;
  now?: () => Date;
}

export interface HarvestOptions {
  mode: "apply" | "patch";
  /** apply mode only: write conflicted files WITH conflict markers instead of aborting */
  allowConflicts?: boolean;
}

/** HarvestResult plus non-fatal warnings (e.g. a merge-node insert failure,
 * or conflicts that cannot take text markers). Structurally compatible with
 * HarvestResult — the extra field is additive. */
export type HarvestOutcome = HarvestResult & { warnings: string[] };

const MANIFEST_NAME = ".sojourn-restore.json";
const PATCH_NAME = ".sojourn-harvest.patch";

/** Sojourn's own artifacts inside a restore worktree — never harvested. */
const ARTIFACT_PATHS = new Set<string>([MANIFEST_NAME, PATCH_NAME]);

const WARNING_SAFETY =
  "A safety snapshot of the mainline project is taken before any harvest write.";
const WARNING_NO_GIT =
  "Harvest writes file contents only — it never touches your project's .git.";

// KNOWN LIMITATION (modes / exec bits / symlink entries): harvest compares
// and transfers file CONTENTS only. A mode-only change on the branch (e.g.
// chmod +x with identical bytes) classifies as "identical" and is skipped;
// applied files are written with default modes; a branch entry that is
// itself a symlink is materialized as a regular file containing the target
// path. Documented in .superpowers/sdd/task-6-report.md.

interface RestoreManifest {
  nodeId: string;
  treeHash: string;
}

async function readManifest(worktreePath: string): Promise<RestoreManifest> {
  const manifestPath = path.join(worktreePath, MANIFEST_NAME);

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new SojournHarvestError(
      `No ${MANIFEST_NAME} found in ${worktreePath} — not a Sojourn restore worktree.`,
      "no_manifest",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SojournHarvestError(`${manifestPath} is not valid JSON.`, "no_manifest");
  }

  const m = parsed as { nodeId?: unknown; treeHash?: unknown };
  if (
    typeof m.nodeId !== "string" ||
    m.nodeId.length === 0 ||
    typeof m.treeHash !== "string" ||
    m.treeHash.length === 0
  ) {
    throw new SojournHarvestError(
      `${manifestPath} is missing required fields (nodeId, treeHash).`,
      "no_manifest",
    );
  }

  return { nodeId: m.nodeId, treeHash: m.treeHash };
}

async function ensureBaseTree(snap: SnapshotterLike, tree: string): Promise<void> {
  if (!(await snap.hasTree(tree))) {
    throw new SojournHarvestError(
      `Base tree ${tree} from the restore manifest is no longer present in the shadow snapshot repo.`,
      "stale_base",
    );
  }
}

/** snapshotSafety when available (private index, never queues behind capture),
 * falling back to snapshot() for snapshotters that don't implement it. */
async function takeSafetySnapshot(snap: SnapshotterLike): Promise<string> {
  return snap.snapshotSafety ? snap.snapshotSafety() : snap.snapshot();
}

/** What the diff itself says about a path on the BRANCH side: "deleted" for
 * status D (or the old-name side of a rename), "present" for everything else
 * (A, M, or the new-name side of a rename). classifyFile cross-checks this
 * against what it actually reads from branchTree. */
type BranchPathStatus = "deleted" | "present";

/**
 * Every path that differs between baseTree and branchTree, with renames
 * expanded into delete(oldPath) + add(newPath) so classification stays purely
 * content-driven, and Sojourn's own worktree artifacts filtered out. Also
 * returns branchStatus (see BranchPathStatus) for the read-failure guard in
 * classifyFile.
 */
async function changedPaths(
  snap: SnapshotterLike,
  baseTree: string,
  branchTree: string,
): Promise<{ paths: string[]; branchStatus: Map<string, BranchPathStatus> }> {
  const changes = await snap.diff(baseTree, branchTree);
  const paths: string[] = [];
  const branchStatus = new Map<string, BranchPathStatus>();
  const seen = new Set<string>();
  const push = (p: string, status: BranchPathStatus): void => {
    if (ARTIFACT_PATHS.has(p)) return;
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
    branchStatus.set(p, status);
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
  return { paths, branchStatus };
}

// ——— binary-safe content plumbing (CRITICAL-1) ———

/** Byte-exact read of a tree file: readFileRaw when the snapshotter provides
 * it, utf8 readFile otherwise (NOT binary-safe — ShadowSnapshotter always
 * provides readFileRaw; the fallback exists only for minimal stubs). */
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

type MainlineRead =
  | { kind: "file"; buf: Buffer }
  | { kind: "absent" }
  /** a directory occupies the path, or a file sits where a directory is needed */
  | { kind: "collision" };

async function readMainlineRaw(mainlineRoot: string, rel: string): Promise<MainlineRead> {
  try {
    return { kind: "file", buf: await fs.readFile(path.join(mainlineRoot, rel)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    // I-3: EISDIR/ENOTDIR is NOT "absent" — something structurally
    // incompatible occupies the destination. Treating it as absent classified
    // the file "clean" and then crashed raw mid-apply.
    if (code === "EISDIR" || code === "ENOTDIR") return { kind: "collision" };
    throw err;
  }
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

// ——— destination safety (CRITICAL-2) ———

function isWithin(realRoot: string, p: string): boolean {
  return p === realRoot || p.startsWith(realRoot + path.sep);
}

type DestSafety = { safe: true } | { safe: false; reason: string };

/**
 * lstat-based guard run BEFORE any write/delete (and again at write time —
 * symlinks can appear between classification and write): the destination
 * itself must not be a symlink (fs.writeFile would follow it and clobber the
 * target, possibly outside the root and outside any snapshot), and every
 * existing intermediate directory component must not be a symlink whose
 * realpath escapes the mainline root. Intermediate symlinks that stay INSIDE
 * the root are allowed — writes still land within the project.
 */
async function checkDestSafety(
  mainlineRoot: string,
  realRoot: string,
  rel: string,
): Promise<DestSafety> {
  const parts = rel.split("/");
  let cur = mainlineRoot;

  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Nothing exists from here down — mkdir will create real directories.
      if (code === "ENOENT") return { safe: true };
      if (code === "ENOTDIR") {
        return {
          safe: false,
          reason: `path component "${parts.slice(0, i + 1).join("/")}" is not a directory`,
        };
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      let real: string | null;
      try {
        real = await fs.realpath(cur);
      } catch {
        real = null; // broken link — treat as escaping
      }
      if (real === null || !isWithin(realRoot, real)) {
        return {
          safe: false,
          reason: `intermediate directory "${parts.slice(0, i + 1).join("/")}" is a symlink pointing outside the mainline root`,
        };
      }
    } else if (!st.isDirectory()) {
      return {
        safe: false,
        reason: `path component "${parts.slice(0, i + 1).join("/")}" exists but is not a directory`,
      };
    }
  }

  const dest = path.join(cur, parts[parts.length - 1]);
  let st;
  try {
    st = await fs.lstat(dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { safe: true };
    throw err;
  }
  if (st.isSymbolicLink()) {
    return {
      safe: false,
      reason: `destination "${rel}" is a symlink — harvest never writes through symlinks`,
    };
  }
  return { safe: true };
}

/**
 * Three-way merge via the system `git merge-file` over TEMP files only —
 * never git plumbing against the user's repo. `-p` keeps it a pure dry-run
 * (result on stdout, inputs untouched). git merge-file exits with the number
 * of conflicts, so a positive exit code is "conflicted", not an error.
 * TEXT ONLY — callers must short-circuit binary content before reaching here.
 */
async function mergeFile(
  ours: string,
  base: string,
  theirs: string,
): Promise<{ conflicted: boolean; content: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sojourn-merge-"));
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
        ["merge-file", "-p", "-L", "mainline", "-L", "base", "-L", "branch", oursPath, basePath, theirsPath],
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
  | { kind: "skip" }
  /** conflict that must NEVER be written (binary conflict, dir collision,
   * symlink destination/escape): under allowConflicts it is reported in
   * `conflicted` but the mainline content stays untouched — text conflict
   * markers are impossible or unsafe for these. */
  | { kind: "keep" }
  | { kind: "delete" }
  | { kind: "write"; content: Buffer };

interface ClassifiedFile {
  path: string;
  status: "clean" | "conflict" | "identical";
  action: FileAction;
  /** true when the mainline's current content differs from baseTree's */
  mainlineDiffersFromBase: boolean;
  /** exact mainline bytes classification observed (null = absent). The write
   * loop re-reads and compares — any drift aborts (I-6), because content that
   * appeared after classification exists in NO snapshot. */
  mainlineSeen: Buffer | null;
}

async function classifyFile(
  snap: SnapshotterLike,
  baseTree: string,
  branchTree: string,
  mainlineRoot: string,
  realRoot: string,
  relPath: string,
  branchStatus: Map<string, BranchPathStatus>,
): Promise<ClassifiedFile> {
  let baseBuf: Buffer | null;
  let branchBuf: Buffer | null;
  try {
    [baseBuf, branchBuf] = await Promise.all([
      readTreeRaw(snap, baseTree, relPath),
      readTreeRaw(snap, branchTree, relPath),
    ]);
  } catch (err) {
    // A thrown read (e.g. the snapshotter hit maxBuffer on a large blob, or
    // any other I/O failure) is never a "this file doesn't exist" signal —
    // see GIT_PATH_ABSENT_RE in shadowSnapshotter.ts. Surface it as a typed,
    // abort-clean error instead of letting classification silently continue
    // on bad data.
    const msg = err instanceof Error ? err.message : String(err);
    throw new ReadFailureSignal(
      relPath,
      `reading this path from the base/branch snapshot failed: ${msg}`,
    );
  }

  // CRITICAL (probe-proven): a null branchBuf below is read as "the branch
  // deleted the file". If the diff says this path is PRESENT on the branch
  // (status A/M, or a rename's new name) but the read came back null anyway
  // — e.g. a snapshotter whose absence/failure distinction is imperfect —
  // treating that as a deletion would silently destroy the mainline's copy
  // of a file that still exists on the branch. Refuse instead.
  if (branchBuf === null && branchStatus.get(relPath) === "present") {
    throw new ReadFailureSignal(
      relPath,
      "the diff reports this path as present on the branch, but reading its content from the branch snapshot returned nothing — refusing to treat this as a branch deletion",
    );
  }

  // CRITICAL-2: never trust the destination path lexically. A mainline
  // symlink at the destination (or a symlinked intermediate dir escaping the
  // root) would route the write OUTSIDE the project — outside every safety
  // snapshot. Conflict, never written.
  const safety = await checkDestSafety(mainlineRoot, realRoot, relPath);
  if (!safety.safe) {
    return {
      path: relPath,
      status: "conflict",
      action: { kind: "keep" },
      mainlineDiffersFromBase: true,
      mainlineSeen: null,
    };
  }

  const mainline = await readMainlineRaw(mainlineRoot, relPath);
  if (mainline.kind === "collision") {
    // I-3: a directory occupies the destination (or a file sits mid-path).
    return {
      path: relPath,
      status: "conflict",
      action: { kind: "keep" },
      mainlineDiffersFromBase: true,
      mainlineSeen: null,
    };
  }
  const mainlineBuf = mainline.kind === "file" ? mainline.buf : null;
  const mainlineDiffersFromBase = !bufEq(mainlineBuf, baseBuf);

  // Mainline already has exactly the branch outcome (same bytes, or both
  // sides deleted): nothing to do.
  if (bufEq(mainlineBuf, branchBuf)) {
    return {
      path: relPath,
      status: "identical",
      action: { kind: "skip" },
      mainlineDiffersFromBase,
      mainlineSeen: mainlineBuf,
    };
  }

  // CRITICAL-1: `git merge-file` is text-only. Any binary participant
  // short-circuits: clean applies copy the branch Buffer verbatim; anything
  // that would need a merge is a conflict — never merged, never markered.
  const binary = isBinary(baseBuf) || isBinary(branchBuf) || isBinary(mainlineBuf);

  if (branchBuf === null) {
    // Branch deleted the file. (mainline-also-deleted was the identical case.)
    if (!mainlineDiffersFromBase) {
      return {
        path: relPath,
        status: "clean",
        action: { kind: "delete" },
        mainlineDiffersFromBase,
        mainlineSeen: mainlineBuf,
      };
    }
    if (binary) {
      return {
        path: relPath,
        status: "conflict",
        action: { kind: "keep" },
        mainlineDiffersFromBase,
        mainlineSeen: mainlineBuf,
      };
    }
    // delete/modify: merge the mainline's edit against whole-file deletion.
    const merged = await mergeFile(asText(mainlineBuf), asText(baseBuf), "");
    if (!merged.conflicted) {
      // Minor-12: honest classification by the ACTUAL merge outcome — e.g.
      // mainline truncated the file while the branch deleted it resolves
      // marker-lessly and belongs in `applied`, not `conflicted`. An empty
      // clean resolution honors the branch's deletion.
      return {
        path: relPath,
        status: "clean",
        action:
          merged.content === ""
            ? { kind: "delete" }
            : { kind: "write", content: Buffer.from(merged.content, "utf8") },
        mainlineDiffersFromBase,
        mainlineSeen: mainlineBuf,
      };
    }
    // markers keep the mainline content visible rather than silently deleting
    return {
      path: relPath,
      status: "conflict",
      action: { kind: "write", content: Buffer.from(merged.content, "utf8") },
      mainlineDiffersFromBase,
      mainlineSeen: mainlineBuf,
    };
  }

  if (!mainlineDiffersFromBase) {
    // Mainline untouched since the restore point — branch bytes land
    // verbatim (binary-safe: Buffer end-to-end). Also covers plain new
    // files: base and mainline both absent.
    return {
      path: relPath,
      status: "clean",
      action: { kind: "write", content: branchBuf },
      mainlineDiffersFromBase,
      mainlineSeen: mainlineBuf,
    };
  }

  if (binary) {
    // Both sides moved on binary content — a text merge would corrupt it.
    return {
      path: relPath,
      status: "conflict",
      action: { kind: "keep" },
      mainlineDiffersFromBase,
      mainlineSeen: mainlineBuf,
    };
  }

  // Both sides moved: real three-way merge. Empty stand-ins cover add/add
  // (no base) and mainline-deleted-while-branch-modified (no ours) — both
  // surface as whole-file conflicts, never silent overwrites.
  const merged = await mergeFile(asText(mainlineBuf), asText(baseBuf), asText(branchBuf));
  return {
    path: relPath,
    status: merged.conflicted ? "conflict" : "clean",
    action: { kind: "write", content: Buffer.from(merged.content, "utf8") },
    mainlineDiffersFromBase,
    mainlineSeen: mainlineBuf,
  };
}

async function classifyAll(
  snap: SnapshotterLike,
  baseTree: string,
  branchTree: string,
  mainlineRoot: string,
  realRoot: string,
  paths: string[],
  branchStatus: Map<string, BranchPathStatus>,
): Promise<ClassifiedFile[]> {
  const classified: ClassifiedFile[] = [];
  for (const p of paths) {
    classified.push(
      await classifyFile(snap, baseTree, branchTree, mainlineRoot, realRoot, p, branchStatus),
    );
  }
  return classified;
}

function buildWarnings(conflictPaths: string[]): string[] {
  const warnings = [WARNING_SAFETY];
  if (conflictPaths.length > 0) {
    warnings.push(
      `Conflicted files (require allowConflicts or manual resolution): ${conflictPaths.join(", ")}`,
    );
  }
  warnings.push(WARNING_NO_GIT);
  return warnings;
}

/** Converts a ReadFailureSignal raised during classification into the typed,
 * abort-clean "read_failed" error. Classification always completes in full
 * BEFORE any mainline write in both harvestPreflight and harvest() apply
 * mode, so this is always reached before anything is written — mirroring
 * the "conflicts" code's abort-clean semantics (no `.partial`, since there
 * is nothing partial: nothing was written at all beyond whatever safety
 * snapshot the caller already took). */
function readFailureError(sig: ReadFailureSignal, safetySnapshotRef?: string): SojournHarvestError {
  const safetyNote = safetySnapshotRef
    ? ` Safety snapshot ${safetySnapshotRef} holds the full pre-harvest mainline.`
    : "";
  return new SojournHarvestError(
    `Harvest aborted: reading "${sig.relPath}" from the snapshot failed — ${sig.reason}. ` +
      `No mainline files were written.${safetyNote}`,
    "read_failed",
    [sig.relPath],
  );
}

/** Resolves `rel` under `root`, refusing anything that would escape it.
 * Lexical first line of defense — symlink escapes are handled by
 * checkDestSafety + the realpath containment check in atomicWrite. */
function resolveWithin(root: string, rel: string): string {
  const normRoot = path.resolve(root);
  const dest = path.resolve(normRoot, rel);
  if (dest !== normRoot && !dest.startsWith(normRoot + path.sep)) {
    throw new Error(`Refusing to write outside the mainline root: ${rel}`);
  }
  return dest;
}

/** tmp file + rename in the (realpath-verified) real parent directory, so a
 * failure mid-write never leaves a torn destination file. */
async function atomicWrite(
  mainlineRoot: string,
  realRoot: string,
  rel: string,
  content: Buffer,
): Promise<void> {
  const dest = resolveWithin(mainlineRoot, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const realParent = await fs.realpath(path.dirname(dest));
  if (!isWithin(realRoot, realParent)) {
    throw new Error(`Resolved parent directory escapes the mainline root: ${rel}`);
  }
  const tmp = path.join(realParent, `.sojourn-harvest-tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, path.join(realParent, path.basename(dest)));
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function harvestPreflight(
  deps: HarvestDeps,
  worktreePath: string,
  mainlineRoot: string,
): Promise<HarvestPreflight> {
  const manifest = await readManifest(worktreePath);
  const snap = deps.snapshotterForRoot(worktreePath);
  await ensureBaseTree(snap, manifest.treeHash);

  const branchTree = await takeSafetySnapshot(snap);
  const { paths, branchStatus } = await changedPaths(snap, manifest.treeHash, branchTree);
  const realRoot = await fs.realpath(mainlineRoot);
  let classified: ClassifiedFile[];
  try {
    classified = await classifyAll(
      snap,
      manifest.treeHash,
      branchTree,
      mainlineRoot,
      realRoot,
      paths,
      branchStatus,
    );
  } catch (err) {
    if (err instanceof ReadFailureSignal) throw readFailureError(err);
    throw err;
  }

  const conflictPaths = classified.filter((c) => c.status === "conflict").map((c) => c.path);

  return {
    worktreePath,
    originNodeId: manifest.nodeId,
    baseTree: manifest.treeHash,
    branchTree,
    files: classified.map((c) => ({ path: c.path, status: c.status })),
    // HONEST SEMANTICS (Minor-10): mainlineDirty answers "did the mainline
    // move on any path THIS HARVEST TOUCHES (base<->branch-changed paths)
    // since the restore point?" It does NOT survey the whole mainline tree —
    // mainline edits to unrelated paths are invisible here (and irrelevant
    // to this merge).
    mainlineDirty: classified.some((c) => c.mainlineDiffersFromBase),
    warnings: buildWarnings(conflictPaths),
  };
}

export async function harvest(
  deps: HarvestDeps,
  worktreePath: string,
  mainlineRoot: string,
  opts: HarvestOptions,
): Promise<HarvestOutcome> {
  // Safety snapshot of the MAINLINE first, unconditionally — before any
  // classification, before any write, in every mode. "Never be the source
  // of data loss" is non-negotiable.
  const mainlineSnap = deps.snapshotterForRoot(mainlineRoot);
  const safetySnapshotRef = await takeSafetySnapshot(mainlineSnap);

  const manifest = await readManifest(worktreePath);
  const branchSnap = deps.snapshotterForRoot(worktreePath);
  await ensureBaseTree(branchSnap, manifest.treeHash);

  const branchTree = await takeSafetySnapshot(branchSnap);
  const { paths, branchStatus } = await changedPaths(branchSnap, manifest.treeHash, branchTree);

  if (opts.mode === "patch") {
    // Patch mode never touches the mainline: compose baseTree..branchTree
    // per-file diffs and write them into the WORKTREE. All chunks are
    // gathered BEFORE the patch file is written, so a failure never leaves
    // a silently-incomplete patch on disk (Minor-9).
    let patch = "";
    for (const p of paths) {
      let chunk: string;
      try {
        chunk = await branchSnap.diffFile(manifest.treeHash, branchTree, p);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SojournHarvestError(
          `Patch generation failed for ${p}: ${msg}. No patch file was written.`,
          "patch_incomplete",
          [p],
        );
      }
      if (chunk === "") {
        // ShadowSnapshotter.diffFile swallows git failures into "" — but
        // every path here DIFFERS between base and branch, so an empty diff
        // means the diff itself failed. Fail loudly (Minor-9).
        throw new SojournHarvestError(
          `Patch generation produced no diff for changed path ${p} — refusing to write an incomplete patch.`,
          "patch_incomplete",
          [p],
        );
      }
      patch += chunk;
    }
    const patchPath = path.join(worktreePath, PATCH_NAME);
    await fs.writeFile(patchPath, patch, "utf8");
    return {
      applied: [],
      conflicted: [],
      skippedIdentical: [],
      safetySnapshotRef,
      patchPath,
      mergeNodeId: null,
      warnings: [],
    };
  }

  const realRoot = await fs.realpath(mainlineRoot);
  let classified: ClassifiedFile[];
  try {
    classified = await classifyAll(
      branchSnap,
      manifest.treeHash,
      branchTree,
      mainlineRoot,
      realRoot,
      paths,
      branchStatus,
    );
  } catch (err) {
    if (err instanceof ReadFailureSignal) throw readFailureError(err, safetySnapshotRef);
    throw err;
  }

  const conflictPaths = classified.filter((c) => c.status === "conflict").map((c) => c.path);
  if (conflictPaths.length > 0 && opts.allowConflicts !== true) {
    // Abort-clean: every classification above was a dry-run over temp files,
    // so at this point ZERO mainline writes have happened.
    throw new SojournHarvestError(
      `Harvest aborted: ${conflictPaths.length} conflicted file(s): ${conflictPaths.join(", ")}. ` +
        `No mainline files were written. Re-run with allowConflicts to write conflict markers, ` +
        `or use mode "patch".`,
      "conflicts",
      conflictPaths,
    );
  }

  const applied: string[] = [];
  const conflicted: string[] = [];
  const skippedIdentical: string[] = [];
  const warnings: string[] = [];

  const queue: ClassifiedFile[] = [];
  for (const c of classified) {
    if (c.action.kind === "skip") {
      skippedIdentical.push(c.path);
    } else {
      queue.push(c);
    }
  }

  let cursor = 0;
  try {
    for (; cursor < queue.length; cursor++) {
      const c = queue[cursor];

      if (c.action.kind === "keep") {
        // Conflict that can never take text markers (binary content, dir
        // collision, symlink destination): reported, mainline untouched.
        conflicted.push(c.path);
        continue;
      }

      const dest = resolveWithin(mainlineRoot, c.path);

      // I-6 + CRITICAL-2 TOCTOU guard: re-verify the destination is still
      // safe and still holds EXACTLY the bytes classification saw. Anything
      // that changed in between exists in NO snapshot — abort rather than
      // clobber it.
      const safety = await checkDestSafety(mainlineRoot, realRoot, c.path);
      if (!safety.safe) {
        throw new DriftSignal(c.path, safety.reason);
      }
      const current = await readMainlineRaw(mainlineRoot, c.path);
      if (current.kind === "collision") {
        throw new DriftSignal(c.path, "the destination became a directory since classification");
      }
      const currentBuf = current.kind === "file" ? current.buf : null;
      if (!bufEq(currentBuf, c.mainlineSeen)) {
        throw new DriftSignal(c.path, "the mainline content changed since classification");
      }

      if (c.action.kind === "delete") {
        await fs.rm(dest, { force: true });
        applied.push(c.path);
      } else if (c.action.kind === "write") {
        await atomicWrite(mainlineRoot, realRoot, c.path, c.action.content);
        if (c.status === "conflict") {
          conflicted.push(c.path);
        } else {
          applied.push(c.path);
        }
      }
      // ("skip" never reaches the queue — filtered into skippedIdentical above)
    }
  } catch (err) {
    // I-4: never let a mid-apply failure discard what already happened.
    const remaining = queue.slice(cursor).map((c) => c.path);
    const partial: HarvestPartialState = {
      applied: [...applied],
      conflicted: [...conflicted],
      remaining,
      safetySnapshotRef,
    };
    if (err instanceof DriftSignal) {
      throw new SojournHarvestError(
        `Harvest aborted before writing ${err.relPath}: ${err.reason}. ` +
          `Nothing further was written; ${applied.length + conflicted.length} file(s) were already applied. ` +
          `Safety snapshot ${safetySnapshotRef} holds the full pre-harvest mainline.`,
        "mainline_drift",
        [err.relPath],
        partial,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    const failedPath = queue[cursor]?.path ?? "(unknown)";
    throw new SojournHarvestError(
      `Harvest failed mid-apply at ${failedPath}: ${msg}. ` +
        `Already-applied and remaining files are recorded on this error (.partial). ` +
        `Safety snapshot ${safetySnapshotRef} holds the full pre-harvest mainline.`,
      "partial_apply",
      [failedPath],
      partial,
    );
  }

  const keptConflicts = classified
    .filter((c) => c.status === "conflict" && c.action.kind === "keep")
    .map((c) => c.path);
  if (keptConflicts.length > 0) {
    warnings.push(
      `${keptConflicts.length} conflicted file(s) cannot take text conflict markers ` +
        `(binary content, directory collision, or symlinked destination) and were left ` +
        `untouched on the mainline: ${keptConflicts.join(", ")}`,
    );
  }

  // I-7: the files are already ON the mainline at this point — a graph
  // bookkeeping failure must not turn a successful harvest into a rejection.
  let mergeNodeId: string | null = null;
  try {
    mergeNodeId = insertMergeNode(deps, manifest, {
      worktreePath,
      mainlineRoot,
      baseTree: manifest.treeHash,
      branchTree,
      applied,
      conflicted,
      skippedIdentical,
      safetySnapshotRef,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(
      `Harvest applied successfully, but recording the merge node in the graph failed: ${msg}`,
    );
  }

  return {
    applied,
    conflicted,
    skippedIdentical,
    safetySnapshotRef,
    patchPath: null,
    mergeNodeId,
    warnings,
  };
}

interface MergeNodeInfo {
  worktreePath: string;
  mainlineRoot: string;
  baseTree: string;
  branchTree: string;
  applied: string[];
  conflicted: string[];
  skippedIdentical: string[];
  safetySnapshotRef: string;
}

/**
 * Graph closure: a checkpoint node parented to the origin (restored-from)
 * node, marking where the branch's work came home. Skipped (null) when no
 * store was injected, when the origin node is unknown to it — we never
 * fabricate project/session identity — or when nothing was actually applied
 * (Minor-11: an all-identical harvest is not a merge).
 */
function insertMergeNode(
  deps: HarvestDeps,
  manifest: RestoreManifest,
  info: MergeNodeInfo,
): string | null {
  const store = deps.store;
  if (!store) return null;

  const fileCount = info.applied.length + info.conflicted.length;
  if (fileCount === 0) return null;

  const origin = store.getNode(manifest.nodeId);
  if (!origin) return null;

  const now = (deps.now ?? (() => new Date()))();
  const node8 = manifest.nodeId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const label = `harvest: ${fileCount} ${fileCount === 1 ? "file" : "files"} from ${node8}`;
  const nativeUuid = `harvest-${crypto.randomUUID()}`;

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
      mainlineRoot: info.mainlineRoot,
      baseTree: info.baseTree,
      branchTree: info.branchTree,
      applied: info.applied,
      conflicted: info.conflicted,
      skippedIdentical: info.skippedIdentical,
      safetySnapshotRef: info.safetySnapshotRef,
    },
    meta: { nativeUuid, forkedFrom: manifest.nodeId },
  };

  store.upsertNode(node);
  return node.id;
}
