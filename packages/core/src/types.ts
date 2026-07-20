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
  /** >0 marks a DIGEST flag: evidence is a sample and this many additional
   * identical-claim flags of the same kind/tier were suppressed by budgets. */
  suppressedCount?: number;
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
  label: string | null;
  summary: string;
  content: unknown;
  flags?: StoredFlag[];
  annotations?: Annotation[];
  meta: {
    nativeUuid: string;
    forkedFrom?: string;
    rewindOf?: string;
    /**
     * PROVENANCE ONLY — the second ancestor of a combine node.
     *
     * `parentId` stays a single nullable string and the graph stays a TREE:
     * a combine node is parented to node A in the normal way, and this
     * field records that node B's file state was merged in as well. Nothing
     * in the graph walks `mergedFrom` as an edge — `findEffectiveTree`,
     * `collectPins`, rewind's ancestor walk and the web layout all remain
     * strictly `parentId`-based.
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

export interface IngestBatch {
  project: { root: string; name: string };
  session: { id: string; cli: Cli; title?: string };
  /** projectId may be "" — the daemon fills it in at ingest time */
  nodes: ChronoNode[];
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

// ——— V2 contracts (plan: docs/superpowers/plans/2026-07-11-sojourn-v2.md) ———

/** Pure counts — never a probabilistic "grade" (verified/advisory stay distinct). */
export interface SessionHealth {
  sessionId: string;
  turns: number;
  verifiedActive: number;
  verifiedResolved: number;
  advisoryActive: number;
  dismissed: number;
  suppressed: number;
}

export interface HarvestPreflight {
  worktreePath: string;
  originNodeId: string;
  baseTree: string;
  branchTree: string;
  files: Array<{ path: string; status: "clean" | "conflict" | "identical" }>;
  mainlineDirty: boolean;
  warnings: string[];
}

export interface HarvestResult {
  applied: string[];
  /** files written WITH conflict markers (allowConflicts mode only) */
  conflicted: string[];
  skippedIdentical: string[];
  safetySnapshotRef: string;
  patchPath: string | null;
  mergeNodeId: string | null;
}

/** Per-file outcome of combining node A's and node B's file states against
 * their nearest common ancestor. Same vocabulary as `HarvestPreflight.files`
 * so the two merges read identically to a consumer. */
export interface CombineFileStatus {
  path: string;
  status: "clean" | "conflict" | "identical";
  /** true when this conflict can never take text conflict markers (binary
   * content on either side) — even under `allowConflicts` it is reported and
   * node A's content is kept verbatim. */
  unmarkable?: boolean;
}

export interface CombinePreflight {
  nodeIdA: string;
  nodeIdB: string;
  /** node whose effective tree is the merge base (nearest common ancestor) */
  baseNodeId: string;
  baseTree: string;
  treeA: string;
  treeB: string;
  files: CombineFileStatus[];
  warnings: string[];
}

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
  /** id of the inserted combine checkpoint node, or null if not recorded */
  combineNodeId: string | null;
  warnings: string[];
}

export interface RewindPlan {
  /** exact = synthesized truncated transcript; tip = native fork fallback */
  mode: "exact" | "tip";
  newSessionId: string | null;
  transcriptPath: string | null;
  /** why exact mode was refused (e.g. compaction boundary) — honesty surface */
  refusedReason: string | null;
  resumeCommand: string;
}

export interface SearchHit {
  node: ChronoNode;
  score: number;
  snippet: string;
}
