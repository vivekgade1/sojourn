import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { GraphStore } from "../store/index.js";
import type { SnapshotterLike } from "../interfaces.js";
import type { ChronoNode, Project, RestorePreflight, RestoreResult } from "../types.js";

/** Stable machine-readable classification for a `SojournRestoreError`,
 * set at each throw site. Consumers (e.g. the daemon's HTTP layer) should
 * switch on this instead of substring-matching `message` — messages may
 * be reworded without changing behavior. */
export type SojournRestoreErrorCode = "not_found" | "invalid_tree" | "dest_exhausted";

export class SojournRestoreError extends Error {
  readonly code: SojournRestoreErrorCode;

  constructor(message: string, code: SojournRestoreErrorCode) {
    super(message);
    this.name = "SojournRestoreError";
    this.code = code;
  }
}

export interface RestoreDeps {
  store: GraphStore;
  snapshotterFor(project: Project): SnapshotterLike;
  worktreesDir: string;
  now?: () => Date;
}

const RESTORE_WARNINGS: string[] = [
  "Bash side effects (commands the assistant ran) are NOT undone by this restore.",
  "Database migrations are NOT undone by this restore.",
  "Network calls (API requests, deployments, etc.) are NOT undone by this restore.",
  "Git pushes to remotes are NOT undone by this restore.",
  "Restore checks out files into a NEW worktree directory; your current working directory is left untouched.",
];

function buildResumeCommand(node: ChronoNode): string | null {
  if (node.cli === "claude") {
    return `claude --resume ${node.sessionId} --fork-session`;
  }
  if (node.cli === "opencode") {
    return `opencode --session ${node.sessionId}`;
  }
  return null;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatTimestamp(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const HH = pad2(d.getHours());
  const MM = pad2(d.getMinutes());
  const SS = pad2(d.getSeconds());
  return `${yyyy}${mm}${dd}${HH}${MM}${SS}`;
}

const MAX_DEST_CREATE_ATTEMPTS = 5;

/**
 * Claims a not-yet-existing worktree destination directory, uniquifying with
 * a short random suffix on collision. The engine (not the snapshotter) owns
 * collision detection: two restores whose computed dest paths collide (e.g.
 * same node restored twice within the same second) MUST land in two
 * different directories rather than silently merging into one.
 *
 * Creates the parent directory (recursive) first, then attempts a strict
 * (non-recursive) mkdir of the leaf dest so an existing directory at that
 * exact path raises EEXIST instead of being silently reused.
 */
async function claimDest(baseDest: string): Promise<string> {
  const parent = path.dirname(baseDest);
  await fs.mkdir(parent, { recursive: true });

  let candidate = baseDest;
  for (let attempt = 0; attempt < MAX_DEST_CREATE_ATTEMPTS; attempt++) {
    try {
      await fs.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const suffix = crypto.randomBytes(1).toString("hex"); // 2 hex chars
      candidate = `${baseDest}-${suffix}`;
    }
  }

  throw new SojournRestoreError(
    `Could not claim a unique worktree directory for ${baseDest} after ${MAX_DEST_CREATE_ATTEMPTS} attempts.`,
    "dest_exhausted",
  );
}

/** Returns the node's own `snapshotRef` if set, otherwise walks `parentId`
 * ancestors upward until one with a non-null `snapshotRef` is found. */
function findTreeHash(
  store: GraphStore,
  node: ChronoNode,
): { treeHash: string | null; sourceNodeId: string } {
  if (node.snapshotRef !== null) {
    return { treeHash: node.snapshotRef, sourceNodeId: node.id };
  }

  const seen = new Set<string>([node.id]);
  let current = node;
  while (current.parentId !== null) {
    if (seen.has(current.parentId)) break; // guard against cycles
    const parent = store.getNode(current.parentId);
    if (!parent) break;
    if (parent.snapshotRef !== null) {
      return { treeHash: parent.snapshotRef, sourceNodeId: parent.id };
    }
    seen.add(parent.id);
    current = parent;
  }

  return { treeHash: null, sourceNodeId: node.id };
}

export class RestoreEngine {
  private readonly store: GraphStore;
  private readonly snapshotterFor: (project: Project) => SnapshotterLike;
  private readonly worktreesDir: string;
  private readonly now: () => Date;

  constructor(deps: RestoreDeps) {
    this.store = deps.store;
    this.snapshotterFor = deps.snapshotterFor;
    this.worktreesDir = deps.worktreesDir;
    this.now = deps.now ?? (() => new Date());
  }

  private getNodeOrThrow(nodeId: string): ChronoNode {
    const node = this.store.getNode(nodeId);
    if (!node) {
      throw new SojournRestoreError(`Node not found: ${nodeId}`, "not_found");
    }
    return node;
  }

  private getProjectOrThrow(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new SojournRestoreError(`Project not found: ${projectId}`, "not_found");
    }
    return project;
  }

  async preflight(nodeId: string): Promise<RestorePreflight> {
    const node = this.getNodeOrThrow(nodeId);
    const project = this.getProjectOrThrow(node.projectId);
    const snapshotter = this.snapshotterFor(project);

    const { treeHash } = findTreeHash(this.store, node);

    const treeValid = treeHash !== null ? await snapshotter.hasTree(treeHash) : false;

    return {
      nodeId,
      treeHash,
      treeValid,
      warnings: [...RESTORE_WARNINGS],
      resumeCommand: buildResumeCommand(node),
    };
  }

  async restore(nodeId: string): Promise<RestoreResult> {
    const preflight = await this.preflight(nodeId);
    if (!preflight.treeValid || preflight.treeHash === null) {
      throw new SojournRestoreError(
        `Cannot restore node ${nodeId}: tree ${preflight.treeHash ?? "(none)"} is not valid/reachable in the shadow snapshot repo.`,
        "invalid_tree",
      );
    }

    const node = this.getNodeOrThrow(nodeId);
    const project = this.getProjectOrThrow(node.projectId);
    const snapshotter = this.snapshotterFor(project);

    // Safety snapshot of current working-dir state ALWAYS happens before
    // any checkout, so nothing dirty is ever lost.
    // Prefer the concurrency-safe variant: a user restore must never wait on
    // (or race) the capture pipeline's shared index / head ref.
    const safetySnapshotRef = await (snapshotter.snapshotSafety
      ? snapshotter.snapshotSafety()
      : snapshotter.snapshot());

    const node8 = nodeId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    const stamp = formatTimestamp(this.now());
    const baseDest = path.join(this.worktreesDir, node.projectId, `${node8}-${stamp}`);

    // The engine owns collision detection: claim a unique dest directory
    // BEFORE handing off to the snapshotter, since restoreToWorktree's own
    // mkdir is recursive (a no-op on an existing dir) and checkout-index
    // would otherwise overwrite into a dir that already has stale/foreign
    // contents.
    const dest = await claimDest(baseDest);

    await snapshotter.restoreToWorktree(preflight.treeHash, dest);

    const restoredAt = this.now().toISOString();
    const result: RestoreResult = {
      worktreePath: dest,
      safetySnapshotRef,
      resumeCommand: preflight.resumeCommand,
      warnings: preflight.warnings,
    };

    const manifest = {
      nodeId,
      treeHash: preflight.treeHash,
      safetySnapshotRef,
      restoredAt,
      resumeCommand: preflight.resumeCommand,
    };
    await fs.writeFile(
      path.join(dest, ".sojourn-restore.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );

    return result;
  }
}
