import fs from "node:fs";
import path from "node:path";
import type {
  CheckContext,
  ChronoNode,
  FetchJson,
  FileChange,
  Flag,
  FlagEngine,
  GraphStore,
  IngestBatch,
  Project,
  SnapshotterLike,
} from "@sojourn/core";
import { applyBudgets, autoResolveFlags } from "@sojourn/core";
import type { SojournEvent } from "./events.js";
import type { TranscriptIndex } from "./transcripts.js";

export interface EventsSink {
  broadcast(event: SojournEvent): void;
}

export interface IngestDeps {
  store: GraphStore;
  /** Returns a (cached, init-once) snapshotter for the given project. */
  snapshotterFor(project: Project): SnapshotterLike;
  flagEngine: FlagEngine;
  events: EventsSink;
  /** fetch-with-timeout used by T1 checks that hit package registries. */
  fetchJson: FetchJson;
  /**
   * Session -> transcript-path/disk-root mapping, maintained by the
   * transcript-driven callers (watcher scans, hook rescans). `ingestBatch`
   * itself never writes it — it receives parsed batches, not file paths.
   */
  transcripts?: TranscriptIndex;
}

export interface IngestResult {
  added: string[];
}

/** True when a project's working directory actually exists on disk (a
 * transcript's recorded cwd may point somewhere that's since been removed,
 * or never existed on this machine — snapshotting must be skipped then). */
function projectRootExists(root: string): boolean {
  if (!root) return false;
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

const RESTORE_MANIFEST_FILENAME = ".sojourn-restore.json";

export interface WorktreeRestoreManifest {
  nodeId: string;
}

/**
 * Reads and validates `<root>/.sojourn-restore.json` (written by
 * `RestoreEngine.restore`). Returns `null` — after at most one stderr log
 * line — when the root is empty, the file is absent (the overwhelmingly
 * common case, so a missing file logs nothing), unreadable, not valid
 * JSON, or missing a non-empty `nodeId` string.
 *
 * Exported for the daemon's harvest/flags routes, which need the same
 * "is this directory a Sojourn restore worktree, and of which node?"
 * answer at request time.
 */
export function readRestoreManifest(root: string): WorktreeRestoreManifest | null {
  // Guard the empty root: path.join("", RESTORE_MANIFEST_FILENAME) is a
  // RELATIVE path (".sojourn-restore.json"), which would probe the DAEMON
  // PROCESS's cwd — a directory that has nothing to do with the batch.
  if (!root) return null;
  const manifestPath = path.join(root, RESTORE_MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `[sojourn] ingest: failed to read worktree restore manifest at ${manifestPath}:`,
        err,
      );
    }
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const nodeId =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { nodeId?: unknown }).nodeId
        : undefined;
    if (typeof nodeId === "string" && nodeId.length > 0) {
      return { nodeId };
    }
    console.error(
      `[sojourn] ingest: invalid worktree restore manifest at ${manifestPath}: missing "nodeId"`,
    );
    return null;
  } catch (err) {
    console.error(
      `[sojourn] ingest: failed to parse worktree restore manifest at ${manifestPath}:`,
      err,
    );
    return null;
  }
}

/** First 8 characters of a node id AFTER its `${cli}:` prefix, e.g.
 * `"claude:abc123def456"` -> `"abc123de"`. Falls back to the first 8 chars
 * of the whole id when there's no colon. */
function shortNodeId(nodeId: string): string {
  const idx = nodeId.indexOf(":");
  const rest = idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
  return rest.slice(0, 8);
}

/**
 * Worktree-project aliasing (V2 Task 7): a session run INSIDE a restored
 * worktree carries `<worktreeRoot>/.sojourn-restore.json`. When that
 * manifest's `nodeId` resolves to a real node whose project still exists,
 * the worktree's session must join that ORIGIN project's graph instead of
 * forking a phantom project keyed by the worktree's own (throwaway) path —
 * otherwise every restore silently breaks the cross-session story for
 * exactly the users who restore most.
 *
 * Fails soft: any missing/unreadable/invalid manifest, or an origin node/
 * project that no longer exists, returns `null` (the caller falls back to
 * normal, non-aliased ingest) after at most one stderr log line.
 */
function resolveWorktreeAlias(
  store: GraphStore,
  diskRoot: string,
): { project: Project; originNodeId: string } | null {
  const manifest = readRestoreManifest(diskRoot);
  if (!manifest) return null;

  const originNode = store.getNode(manifest.nodeId);
  if (!originNode) {
    console.error(
      `[sojourn] ingest: worktree restore manifest at ${diskRoot} references unknown node ` +
        `${manifest.nodeId}; ingesting as a normal (non-aliased) project`,
    );
    return null;
  }

  const originProject = store.getProject(originNode.projectId);
  if (!originProject) {
    console.error(
      `[sojourn] ingest: worktree restore manifest at ${diskRoot} references node ` +
        `${manifest.nodeId} whose project ${originNode.projectId} no longer exists; ingesting ` +
        `as a normal (non-aliased) project`,
    );
    return null;
  }

  return { project: originProject, originNodeId: manifest.nodeId };
}

/**
 * Runs one ingestion pass for a parsed batch of nodes (typically an entire
 * transcript file, since adapters/watcher re-parse the whole file on every
 * change and upserts are idempotent).
 *
 * Every phase is independently wrapped in try/catch: ingestion must NEVER
 * throw out of the watcher loop — capture is passive and must never break
 * the user's session. A failure in one phase (snapshotting, flag checks,
 * event emission, ...) is logged to stderr and the pipeline continues with
 * whatever phases remain.
 */
export async function ingestBatch(
  deps: IngestDeps,
  batch: IngestBatch,
): Promise<IngestResult> {
  const { store } = deps;
  const added: string[] = [];

  // The transcript's own recorded root — always the filesystem location to
  // check for on-disk existence and to snapshot FROM, whether or not the
  // batch ends up aliased into another project's graph.
  const diskRoot = batch.project.root;

  let project: Project;
  let originNodeId: string | null = null;
  try {
    const alias = resolveWorktreeAlias(store, diskRoot);
    if (alias) {
      project = alias.project;
      originNodeId = alias.originNodeId;
    } else {
      project = store.upsertProject(batch.project.root, batch.project.name);
    }
  } catch (err) {
    console.error("[sojourn] ingest: failed to upsert project:", err);
    return { added };
  }

  try {
    store.upsertSession({
      id: batch.session.id,
      projectId: project.id,
      cli: batch.session.cli,
      title: originNodeId !== null ? `worktree:${shortNodeId(originNodeId)}` : batch.session.title,
    });
  } catch (err) {
    console.error("[sojourn] ingest: failed to upsert session:", err);
  }

  const newNodes: ChronoNode[] = [];
  // Aliased batches get exactly one fork edge per batch: the first node
  // whose parent doesn't resolve (the transcript's own session root, whose
  // parser-assigned parentId is always null — or an orphaned reference) is
  // reparented to the origin node, with meta.forkedFrom recording the
  // branch-to-origin edge.
  //
  // This is NOT gated on the node being new to the store: adapters re-parse
  // the whole transcript file on every batch (see the doc comment on this
  // function), so the SAME root node arrives with its parser-natural
  // parentId (null) on every subsequent ingest too, and store.upsertNode()
  // unconditionally overwrites parent_id — gating this on isNew would let
  // the second batch silently overwrite the fork edge back to null. Since
  // only the transcript's true root (or a genuinely unresolvable reference)
  // ever satisfies the condition below, re-applying it on every batch is
  // idempotent and harmless for every other (already-parented) node in the
  // session, which is what actually gives "subsequent batches keep natural
  // parentage" for the REST of the graph.
  let forkEdgeApplied = false;

  for (const rawNode of batch.nodes) {
    const node: ChronoNode = { ...rawNode, projectId: project.id };
    try {
      const existing = store.getNode(node.id);
      const isNew = existing === null;

      const takesForkEdge =
        originNodeId !== null &&
        !forkEdgeApplied &&
        (node.parentId === null || store.getNode(node.parentId) === null);
      if (takesForkEdge && originNodeId !== null) {
        node.parentId = originNodeId;
        node.meta = { ...node.meta, forkedFrom: originNodeId };
      }

      store.upsertNode(node);

      // Only mark the fork edge consumed AFTER the upsert actually landed:
      // if this node's upsert throws (e.g. unserializable content), the
      // edge was never persisted, and the next node whose parent doesn't
      // resolve must still get its chance — otherwise the batch's fork
      // edge would be silently lost for good.
      if (takesForkEdge) forkEdgeApplied = true;

      if (isNew) {
        newNodes.push(node);
        added.push(node.id);
      }
    } catch (err) {
      console.error(`[sojourn] ingest: failed to upsert node ${node.id}:`, err);
    }
  }

  // Snapshot ONCE per batch (not per-node) — only if the project root
  // exists on disk (the recorded cwd may not exist on this machine) and
  // there's at least one new tool_result/assistant node to anchor it to.
  const snapshotAnchors = newNodes.filter(
    (n) => n.kind === "tool_result" || n.kind === "assistant",
  );

  // For aliased (worktree) batches, the snapshot must capture the
  // WORKTREE's files. Pass a synthetic project that carries the ORIGIN's id
  // (so blobs/trees land in the origin's shadow git object store, staying
  // valid against — and diffable with — the origin's history) but the
  // worktree's root (so the git work-tree actually read from is the
  // restored worktree, not the mainline checkout).
  const snapshotProject: Project =
    originNodeId !== null ? { ...project, root: diskRoot } : project;

  let snapshotter: SnapshotterLike | null = null;
  let nodeTree: string | null = null;

  if (snapshotAnchors.length > 0 && projectRootExists(diskRoot)) {
    try {
      snapshotter = deps.snapshotterFor(snapshotProject);
      await snapshotter.init();
      nodeTree = await snapshotter.snapshot();
      const last = newNodes[newNodes.length - 1];
      store.setSnapshotRef(last.id, nodeTree);
      last.snapshotRef = nodeTree;
    } catch (err) {
      console.error("[sojourn] ingest: snapshot failed:", err);
      snapshotter = null;
      nodeTree = null;
    }
  }

  // Run T1 flags on new assistant nodes, budgeted per turn segment.
  const newAssistantNodes = newNodes.filter((n) => n.kind === "assistant");
  if (newAssistantNodes.length > 0) {
    interface FlagProduction {
      node: ChronoNode;
      ctx: CheckContext;
      flags: Flag[];
      /** grouping key: the turn prompt's id ("" when no ancestor prompt) */
      turnKey: string;
      turnPromptId: string | null;
      /** true only when the turn diff was actually computed (not a failure fallback) */
      diffComputed: boolean;
    }

    // Phase 1: run the checks per node — nothing is persisted yet, so
    // budgets below can see one whole turn segment's flags at once.
    const productions: FlagProduction[] = [];
    for (const node of newAssistantNodes) {
      try {
        const sessionNodes = store.getSessionNodes(node.sessionId);
        const turnPrompt = resolveTurnPrompt(store, node);
        const parentTree = resolveTurnBaseTree(store, node);
        const effectiveNodeTree = node.snapshotRef ?? nodeTree;

        let diff: FileChange[] = [];
        let diffComputed = false;
        if (snapshotter && effectiveNodeTree !== null) {
          try {
            diff = await snapshotter.diff(parentTree, effectiveNodeTree);
            diffComputed = true;
          } catch (err) {
            console.error("[sojourn] ingest: diff failed for flag context:", err);
          }
        }

        const ctx: CheckContext = {
          node,
          priorNodes: sessionNodes,
          diff,
          parentTree,
          nodeTree: effectiveNodeTree,
          projectRoot: diskRoot,
          snapshotter,
          fetchJson: deps.fetchJson,
        };

        const flags = await deps.flagEngine.runOnNode(ctx);
        productions.push({
          node,
          ctx,
          flags,
          turnKey: turnPrompt?.id ?? "",
          turnPromptId: turnPrompt?.id ?? null,
          diffComputed,
        });
      } catch (err) {
        console.error(`[sojourn] ingest: flag run failed for node ${node.id}:`, err);
      }
    }

    // Phase 2: split into consecutive same-turn segments (nodes arrive in
    // transcript order, so a turn's nodes are contiguous within a batch).
    //
    // BUDGET GRANULARITY — honest limits: `applyBudgets` runs over the
    // flags freshly produced for THIS batch's new assistant nodes, one turn
    // segment at a time. Flags only ever run on NEW nodes, so a turn that
    // spans several debounced batches is budgeted per batch segment, not
    // across the whole turn: an earlier segment's kept flags don't count
    // against a later segment's budget (worst case, a turn split across N
    // batches can keep up to N× the per-turn budget). Identical claims
    // re-produced across segments still collapse at the store level via
    // the (node_id, kind, evidence) uniqueness key.
    const segments: FlagProduction[][] = [];
    for (const p of productions) {
      const last = segments[segments.length - 1];
      if (last && last[0].turnKey === p.turnKey) last.push(p);
      else segments.push([p]);
    }

    const batchTail = newNodes[newNodes.length - 1];

    for (const segment of segments) {
      // Phase 3: budgets over the segment's flags, then persist kept +
      // digests. `applyBudgets` preserves object identity in `kept`, so
      // each kept flag can be routed back to the node that produced it.
      const changedFlagNodeIds = new Set<string>();
      try {
        const allFlags: Flag[] = [];
        const ownerOf = new Map<Flag, ChronoNode>();
        for (const p of segment) {
          for (const f of p.flags) {
            allFlags.push(f);
            ownerOf.set(f, p.node);
          }
        }

        if (allFlags.length > 0) {
          const { kept, digests } = applyBudgets(allFlags);

          for (const f of kept) {
            const owner = ownerOf.get(f) ?? segment[segment.length - 1].node;
            store.addFlag(owner.id, f);
            changedFlagNodeIds.add(owner.id);
          }

          // Each digest lands on the node that produced the LAST flag of
          // its (kind, tier, source) group — a stable anchor within the
          // segment, and addFlag's digest upsert (count-free evidence)
          // keeps re-runs updating the same row in place.
          for (const digest of digests) {
            let owner: ChronoNode = segment[segment.length - 1].node;
            for (let i = allFlags.length - 1; i >= 0; i--) {
              const f = allFlags[i];
              if (
                f.kind === digest.kind &&
                f.tier === digest.tier &&
                f.source === digest.source
              ) {
                owner = ownerOf.get(f) ?? owner;
                break;
              }
            }
            store.addFlag(owner.id, digest);
            changedFlagNodeIds.add(owner.id);
          }
        }
      } catch (err) {
        console.error("[sojourn] ingest: flag budgeting/persist failed:", err);
      }

      // Phase 4: index the turn's files (decision-memory `node_files`) onto
      // the turn's prompt node and the batch-tail node. Uses the segment's
      // LAST successfully computed turn diff (the fullest view of the turn
      // so far); indexNodeFiles REPLACES a node's rows, so later batches of
      // the same turn overwrite with the fuller diff. Skipped when the turn
      // has no grounded base (parentTree null — diff(null, tree) lists the
      // entire tree, which is not a turn diff).
      try {
        for (let i = segment.length - 1; i >= 0; i--) {
          const p = segment[i];
          if (!p.diffComputed || p.ctx.parentTree === null) continue;
          if (p.turnPromptId !== null) store.indexNodeFiles(p.turnPromptId, p.ctx.diff);
          if (batchTail) store.indexNodeFiles(batchTail.id, p.ctx.diff);
          break;
        }
      } catch (err) {
        console.error("[sojourn] ingest: indexNodeFiles failed:", err);
      }

      // Phase 5: auto-resolve earlier flags against each node's ground
      // truth. autoResolveFlags re-evaluates each earlier flag over the
      // span from that flag's OWN turn base to the current tree (via
      // turnBaseOf), so flags about files the current turn didn't touch
      // neither spuriously resolve nor stay stuck.
      const resolvedNodeIds = new Set<string>();
      for (const p of segment) {
        try {
          await autoResolveFlags(
            store,
            p.node,
            p.ctx,
            (resolvedNodeId) => {
              resolvedNodeIds.add(resolvedNodeId);
            },
            (n) => resolveTurnBaseTree(store, n),
          );
        } catch (err) {
          console.error("[sojourn] ingest: autoResolveFlags failed:", err);
        }
      }

      // Always broadcast a node's FULL current flag list (never just the
      // delta) so clients can replace, never merge.
      for (const nodeId of new Set([...changedFlagNodeIds, ...resolvedNodeIds])) {
        try {
          deps.events.broadcast({
            type: "flags_updated",
            nodeId,
            flags: store.getFlags(nodeId),
          });
        } catch (err) {
          console.error("[sojourn] ingest: failed to broadcast flags_updated:", err);
        }
      }
    }
  }

  // Emit node_added for every new node, and a single project_updated.
  for (const node of newNodes) {
    try {
      deps.events.broadcast({ type: "node_added", node });
    } catch (err) {
      console.error("[sojourn] ingest: failed to broadcast node_added:", err);
    }
  }

  if (newNodes.length > 0) {
    try {
      deps.events.broadcast({ type: "project_updated", projectId: project.id });
    } catch (err) {
      console.error("[sojourn] ingest: failed to broadcast project_updated:", err);
    }
  }

  return { added };
}

/**
 * Nearest ancestor PROMPT node (strictly above `node`) — the start of the
 * node's turn. Cycle-guarded; null when the chain reaches a root (or a
 * missing/cyclic parent) without meeting a prompt.
 */
export function resolveTurnPrompt(store: GraphStore, node: ChronoNode): ChronoNode | null {
  const seen = new Set<string>([node.id]);
  let current: ChronoNode | null = node;
  while (current && current.parentId !== null) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    const parent = store.getNode(current.parentId);
    if (!parent) break;
    if (parent.kind === "prompt") return parent;
    current = parent;
  }
  return null;
}

/**
 * Turn-scoped grounding base for a node's CheckContext (`parentTree`).
 *
 * Walks the parentId chain to the nearest ANCESTOR PROMPT node (the start of
 * the current turn), then returns the nearest snapshotRef at-or-before that
 * prompt (the prompt's own snapshotRef if it somehow has one, else the first
 * ancestor snapshot above it). Returns null when there is no ancestor prompt
 * (or no snapshot before it) — checks that need ground truth stay silent.
 *
 * WHY the prompt, not the nearest snapshot: adapters deliver transcripts in
 * debounce-sized batches, so an Edit tool_result (batch A, snapshot S1) and
 * the assistant's claim about that edit (batch B, snapshot S2 == S1) often
 * land in DIFFERENT batches. A nearest-snapshot base would make the claim's
 * step-diff empty and fire a false edit_claim_mismatch on a truthful claim.
 * Grounding at the turn's prompt makes ctx.diff cover the WHOLE turn's
 * changes, which is what the assistant's prose is actually describing.
 */
export function resolveTurnBaseTree(store: GraphStore, node: ChronoNode): string | null {
  // 1) Find the nearest ancestor prompt node (strictly above `node`).
  const turnPrompt = resolveTurnPrompt(store, node);
  if (!turnPrompt) return null;

  // 2) Nearest snapshot at-or-before the prompt: the prompt itself first,
  //    then its ancestors.
  if (turnPrompt.snapshotRef !== null) return turnPrompt.snapshotRef;
  const seenAbove = new Set<string>([turnPrompt.id]);
  let cursor: ChronoNode | null = turnPrompt;
  while (cursor && cursor.parentId !== null) {
    if (seenAbove.has(cursor.parentId)) break;
    seenAbove.add(cursor.parentId);
    const parent = store.getNode(cursor.parentId);
    if (!parent) break;
    if (parent.snapshotRef !== null) return parent.snapshotRef;
    cursor = parent;
  }
  return null;
}
