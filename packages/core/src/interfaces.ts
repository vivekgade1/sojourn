import type { ChronoNode, FileChange, Flag, FlagKind } from "./types.js";

export interface SnapshotterLike {
  init(): Promise<void>;
  snapshot(): Promise<string>;
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
  /** parentTree -> nodeTree */
  diff: FileChange[];
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
