import type { ChronoNode, FileChange, Flag, FlagKind } from "./types.js";

export interface SnapshotterLike {
  init(): Promise<void>;
  snapshot(): Promise<string>;
  /**
   * Like snapshot(), but safe to run CONCURRENTLY with snapshot(): uses a
   * private temp index and its own ref (never the shared ingest index or
   * refs/sojourn/head). The restore path uses this for its safety snapshot
   * so an explicit user restore never queues behind capture work.
   * Optional: callers fall back to snapshot() when absent.
   */
  snapshotSafety?(): Promise<string>;
  hasTree(tree: string): Promise<boolean>;
  diff(treeA: string | null, treeB: string): Promise<FileChange[]>;
  diffFile(treeA: string | null, treeB: string, path: string): Promise<string>;
  listFiles(tree: string): Promise<string[]>;
  readFile(tree: string, path: string): Promise<string | null>;
  restoreToWorktree(tree: string, destDir: string): Promise<void>;
}

export interface FetchJson {
  (url: string): Promise<{ status: number; body: unknown }>;
}

export interface CheckContext {
  node: ChronoNode;
  /** same-session nodes, chronological, including `node` */
  priorNodes: ChronoNode[];
  /** parentTree -> nodeTree, i.e. everything that changed during the turn */
  diff: FileChange[];
  /**
   * TURN-scoped grounding base: the snapshotRef nearest at-or-before the
   * node's closest ancestor PROMPT node (the start of the current turn) —
   * NOT simply the previous snapshot. Adapters ingest in debounced batches,
   * so a tool edit and the assistant's claim about it can carry different
   * snapshots; grounding at the turn's prompt makes `diff` cover the whole
   * turn's changes (what the assistant's prose actually describes). Null
   * when no ancestor prompt / no snapshot before it — checks stay silent.
   */
  parentTree: string | null;
  nodeTree: string | null;
  projectRoot: string;
  snapshotter: SnapshotterLike | null;
  fetchJson: FetchJson;
}

export interface FlagCheck {
  kind: FlagKind;
  appliesTo(node: ChronoNode): boolean;
  run(ctx: CheckContext): Promise<Flag[]>;
}
