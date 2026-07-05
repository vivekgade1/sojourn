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
  label: string | null;
  summary: string;
  content: unknown;
  flags?: StoredFlag[];
  annotations?: Annotation[];
  meta: { nativeUuid: string; forkedFrom?: string };
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
