import type { GraphStore } from "./graphStore.js";
import type { ChronoNode } from "../types.js";

/**
 * The ONE definition of a node's *effective* snapshot tree, shared by
 * restore (RestoreEngine.findTreeHash) and retention (collectPins) so that
 * "what restore would check out" and "what gc must never prune" stay
 * identical by construction (V2 must-fix I1: /api/mark nodes always carry
 * `snapshotRef: null`, so their restorable tree lives on an ancestor).
 *
 * Returns the node's own `snapshotRef` if set, otherwise walks `parentId`
 * ancestors upward (cycle-guarded) until one with a non-null `snapshotRef`
 * is found. `sourceNodeId` names the node that actually held the tree.
 */
export function findEffectiveTree(
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

/**
 * Walks `parentId` upward from `node`, yielding the node itself first and
 * then each ancestor, stopping at the root, at a missing parent, or at a
 * cycle. Cycle guard is identical to `findEffectiveTree`'s (a `seen` set
 * checked before each hop) — a corrupt parent chain must terminate, never
 * spin.
 */
function* ancestorChain(store: GraphStore, node: ChronoNode): Generator<ChronoNode> {
  const seen = new Set<string>([node.id]);
  let current = node;
  yield current;
  while (current.parentId !== null) {
    if (seen.has(current.parentId)) break; // guard against cycles
    const parent = store.getNode(current.parentId);
    if (!parent) break;
    seen.add(parent.id);
    current = parent;
    yield current;
  }
}

/**
 * Nearest common ancestor of two nodes in the `parentId` tree, used by
 * combine as the MERGE BASE for its three-way merge.
 *
 * "Ancestor" is meant in the ancestor-OR-SELF sense: if `b` is a descendant
 * of `a` (or the two are the same node), `a` itself is returned. That is the
 * correct merge base — a's tree is genuinely the last state both sides
 * shared, and the merge degenerates to "apply b's changes", which is what
 * you want.
 *
 * Returns `null` when the two chains never meet — different roots, or a
 * parent chain broken by a missing/cyclic link. Callers MUST treat null as
 * a refusal (there is no honest base to merge against), never as "use the
 * root".
 *
 * Deliberately returns the ancestor NODE, not a tree: resolving it to a
 * snapshot is `findEffectiveTree`'s job and must go through that one shared
 * definition, so combine's notion of "the base tree" can never drift from
 * restore's and gc's.
 */
export function findNearestCommonAncestor(
  store: GraphStore,
  a: ChronoNode,
  b: ChronoNode,
): ChronoNode | null {
  const ancestorsOfA = new Map<string, ChronoNode>();
  for (const n of ancestorChain(store, a)) {
    ancestorsOfA.set(n.id, n);
  }
  for (const n of ancestorChain(store, b)) {
    const hit = ancestorsOfA.get(n.id);
    if (hit) return hit;
  }
  return null;
}
