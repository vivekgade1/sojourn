// Browser-side copies of the handful of @sojourn/core shapes the web UI needs.
// The web package must NOT import @sojourn/core (it's a browser bundle) — keep
// this file in sync with packages/core/src/types.ts by hand.

export type Cli = "claude" | "opencode";

export type NodeKind =
  | "prompt"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "decision"
  | "assumption"
  | "fork_point"
  | "checkpoint";

export type FlagTier = "verified" | "advisory";

export type FlagKind =
  | "edit_claim_mismatch"
  | "package_hallucination"
  | "symbol_not_found"
  | "file_ref_missing"
  | "test_claim_unverified"
  | "unstated_assumption"
  | "possible_hallucination";

export interface Flag {
  kind: FlagKind;
  tier: FlagTier;
  confidence: "high" | "medium" | "low";
  evidence: string;
  source: "deterministic" | "llm_critic";
  autoResolved?: boolean;
}

export interface StoredFlag extends Flag {
  id: number;
  nodeId: string;
  dismissed: boolean;
  createdAt: string;
}

export interface Annotation {
  id: number;
  nodeId: string;
  text: string;
  createdAt: string;
}

export interface ChronoNode {
  /** `${cli}:${nativeUuid}` */
  id: string;
  parentId: string | null;
  kind: NodeKind;
  cli: Cli;
  sessionId: string;
  projectId: string;
  /** ISO 8601 */
  timestamp: string;
  /** git tree hash of the WHOLE working dir, from the shadow repo */
  snapshotRef: string | null;
  /**
   * True iff a restore at this node is possible — its own snapshot, else the
   * nearest ancestor's, still exists in the shadow repo. `false` means restore
   * is impossible (thinned by `soj gc`, or never captured). A MISSING field is
   * treated as restorable/unknown-safe by the UI (backward compatibility —
   * never disable restore on absence).
   */
  restorable?: boolean;
  label: string | null;
  summary: string;
  content: unknown;
  flags?: StoredFlag[];
  annotations?: Annotation[];
  meta: {
    nativeUuid: string;
    forkedFrom?: string;
    /**
     * PROVENANCE ONLY — the second ancestor of a combine node. The graph stays
     * a TREE: `parentId` remains single and unchanged (it points at node A);
     * node B is recorded here and is NOT a walkable parent edge.
     */
    mergedFrom?: string;
  };
}

export interface Project {
  id: string;
  root: string;
  name: string;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  projectId: string;
  cli: Cli;
  title: string | null;
  createdAt: string;
}

export interface FileChange {
  path: string;
  status: "A" | "M" | "D" | "R";
  oldPath?: string;
}

export interface RestorePreflight {
  nodeId: string;
  treeHash: string | null;
  treeValid: boolean;
  /** side effects that will NOT be undone */
  warnings: string[];
  resumeCommand: string | null;
}

export interface RestoreResult {
  worktreePath: string;
  safetySnapshotRef: string;
  resumeCommand: string | null;
  warnings: string[];
}

/**
 * Harvest — mirrors @sojourn/core's HarvestPreflight (types.ts:127-135).
 * `mainlineDirty` is NARROW: the mainline moved on a path THIS harvest would
 * touch — NOT "the working tree has uncommitted changes somewhere".
 */
export interface HarvestPreflight {
  worktreePath: string;
  originNodeId: string;
  baseTree: string;
  branchTree: string;
  files: Array<{ path: string; status: "clean" | "conflict" | "identical" }>;
  mainlineDirty: boolean;
  warnings: string[];
}

/**
 * Mirrors core's HarvestResult (types.ts:137-145). Apply and patch mode are
 * STRUCTURALLY different: patch returns all three arrays empty, mergeNodeId
 * null, and a non-null patchPath — so branch on `patchPath !== null` rather
 * than reporting "0 files applied". `mergeNodeId === null` is not an error
 * (no store, unknown origin node, or zero files touched all produce it).
 * `safetySnapshotRef` is always populated, in both modes.
 */
export interface HarvestResult {
  applied: string[];
  /**
   * Mixed bag by design: files written WITH conflict markers, AND files that
   * could take no markers (binary, directory collision, symlinked
   * destination) and were therefore left COMPLETELY UNTOUCHED. Only
   * `warnings` distinguishes the two — never render this list without them.
   */
  conflicted: string[];
  skippedIdentical: string[];
  safetySnapshotRef: string;
  patchPath: string | null;
  mergeNodeId: string | null;
}

/** Non-fatal notes accompanying a harvest outcome (core's HarvestOutcome). */
export type HarvestOutcome = HarvestResult & { warnings: string[] };

/**
 * Carried on a 500 (`partial_apply` / `mainline_drift`) ONLY: the mainline WAS
 * written to, and this says exactly how far it got and where the pre-harvest
 * state lives. Mirrors core's HarvestPartialState.
 */
export interface HarvestPartialState {
  applied: string[];
  conflicted: string[];
  /** actionable paths NOT yet processed when the failure hit */
  remaining: string[];
  safetySnapshotRef: string;
}

/**
 * Combine — mirrors @sojourn/core's CombineFileStatus (types.ts:165-172).
 * Same status vocabulary as HarvestPreflight.files so the two merges read
 * identically. `unmarkable` marks a conflict that can NEVER take text conflict
 * markers (binary on either side); even under allowConflicts it is reported
 * and node A's content is kept verbatim.
 */
export interface CombineFileStatus {
  path: string;
  status: "clean" | "conflict" | "identical";
  unmarkable?: boolean;
}

/**
 * Mirrors core's CombinePreflight (types.ts:174-184). PURE — the server writes
 * nothing to run this, so it is safe to call as often as the UI likes.
 * `baseNodeId` is the nearest common ancestor whose effective tree is the
 * three-way merge base.
 */
export interface CombinePreflight {
  nodeIdA: string;
  nodeIdB: string;
  baseNodeId: string;
  baseTree: string;
  treeA: string;
  treeB: string;
  files: CombineFileStatus[];
  warnings: string[];
}

/**
 * Mirrors core's CombineResult (types.ts:186-203). `worktreePath` is the whole
 * deliverable: combine emits FILES ONLY into a new worktree and never
 * synthesizes a transcript.
 *
 * `conflicted` and `unmarkable` are NOT the same thing and must never be
 * merged into one list: `conflicted` files were written WITH conflict markers;
 * `unmarkable` files could not take markers (binary, directory collision) and
 * node A's content was kept as-is.
 *
 * `combineNodeId === null` is NOT an error (no store, unknown origin node, or
 * zero files written all produce it).
 */
export interface CombineResult {
  worktreePath: string;
  nodeIdA: string;
  nodeIdB: string;
  baseNodeId: string;
  baseTree: string;
  treeA: string;
  treeB: string;
  /** paths where B's side was merged in cleanly */
  applied: string[];
  /** paths written WITH conflict markers (allowConflicts mode only) */
  conflicted: string[];
  /** conflicts that could not take markers — A's content kept as-is */
  unmarkable: string[];
  skippedIdentical: string[];
  combineNodeId: string | null;
  warnings: string[];
}

/**
 * Carried on a combine 500 (`write_failed`) ONLY. Mirrors core's
 * CombinePartialState. The half-built worktree is deliberately NOT deleted —
 * it holds real merged content — so this is recovery detail, not a bare error.
 * Structurally distinct from HarvestPartialState: there is no safety snapshot
 * (nothing outside the new worktree was ever touched), and a `worktreePath`
 * instead.
 */
export interface CombinePartialState {
  worktreePath: string;
  applied: string[];
  conflicted: string[];
  /** actionable paths NOT yet processed when the failure hit */
  remaining: string[];
}

export interface GraphResponse {
  project: Project;
  sessions: SessionRow[];
  nodes: ChronoNode[];
}

export type WsEvent =
  | { type: "node_added"; node: ChronoNode }
  | { type: "flags_updated"; nodeId: string; flags: StoredFlag[] }
  | { type: "project_updated"; projectId: string };
