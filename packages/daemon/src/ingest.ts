import fs from "node:fs";
import type {
  ChronoNode,
  FetchJson,
  FileChange,
  FlagEngine,
  GraphStore,
  IngestBatch,
  Project,
  SnapshotterLike,
} from "@sojourn/core";
import { autoResolveFlags } from "@sojourn/core";
import type { SojournEvent } from "./events.js";

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

  let project: Project;
  try {
    project = store.upsertProject(batch.project.root, batch.project.name);
  } catch (err) {
    console.error("[sojourn] ingest: failed to upsert project:", err);
    return { added };
  }

  try {
    store.upsertSession({
      id: batch.session.id,
      projectId: project.id,
      cli: batch.session.cli,
      title: batch.session.title,
    });
  } catch (err) {
    console.error("[sojourn] ingest: failed to upsert session:", err);
  }

  const newNodes: ChronoNode[] = [];

  for (const rawNode of batch.nodes) {
    const node: ChronoNode = { ...rawNode, projectId: project.id };
    try {
      const existing = store.getNode(node.id);
      const isNew = existing === null;

      store.upsertNode(node);

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

  let snapshotter: SnapshotterLike | null = null;
  let nodeTree: string | null = null;

  if (snapshotAnchors.length > 0 && projectRootExists(project.root)) {
    try {
      snapshotter = deps.snapshotterFor(project);
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

  // Run T1 flags on new assistant nodes.
  const newAssistantNodes = newNodes.filter((n) => n.kind === "assistant");
  if (newAssistantNodes.length > 0) {
    for (const node of newAssistantNodes) {
      try {
        const sessionNodes = store.getSessionNodes(node.sessionId);
        const parentTree = resolveTurnBaseTree(store, node);
        const effectiveNodeTree = node.snapshotRef ?? nodeTree;

        let diff: FileChange[] = [];
        if (snapshotter && effectiveNodeTree !== null) {
          try {
            diff = await snapshotter.diff(parentTree, effectiveNodeTree);
          } catch (err) {
            console.error("[sojourn] ingest: diff failed for flag context:", err);
          }
        }

        const ctx = {
          node,
          priorNodes: sessionNodes,
          diff,
          parentTree,
          nodeTree: effectiveNodeTree,
          projectRoot: project.root,
          snapshotter,
          fetchJson: deps.fetchJson,
        };

        const flags = await deps.flagEngine.runOnNode(ctx);
        const stored = flags.map((f) => store.addFlag(node.id, f));

        // autoResolveFlags re-evaluates earlier flags against the SAME
        // turn-scoped ctx built above; collect which nodes actually had a
        // flag resolved so their (full) flag lists can be re-broadcast.
        const resolvedNodeIds = new Set<string>();
        try {
          await autoResolveFlags(store, node, ctx, (resolvedNodeId) => {
            resolvedNodeIds.add(resolvedNodeId);
          });
        } catch (err) {
          console.error("[sojourn] ingest: autoResolveFlags failed:", err);
        }

        if (stored.length > 0) {
          try {
            // Always broadcast the node's FULL current flag list (not just
            // the newly added flags) so clients can replace, never merge.
            deps.events.broadcast({
              type: "flags_updated",
              nodeId: node.id,
              flags: store.getFlags(node.id),
            });
          } catch (err) {
            console.error("[sojourn] ingest: failed to broadcast flags_updated:", err);
          }
        }

        for (const resolvedNodeId of resolvedNodeIds) {
          try {
            deps.events.broadcast({
              type: "flags_updated",
              nodeId: resolvedNodeId,
              flags: store.getFlags(resolvedNodeId),
            });
          } catch (err) {
            console.error(
              "[sojourn] ingest: failed to broadcast flags_updated after auto-resolve:",
              err,
            );
          }
        }
      } catch (err) {
        console.error(`[sojourn] ingest: flag run failed for node ${node.id}:`, err);
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
  const seen = new Set<string>([node.id]);
  let current: ChronoNode | null = node;
  let turnPrompt: ChronoNode | null = null;
  while (current && current.parentId !== null) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    const parent = store.getNode(current.parentId);
    if (!parent) break;
    if (parent.kind === "prompt") {
      turnPrompt = parent;
      break;
    }
    current = parent;
  }
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
