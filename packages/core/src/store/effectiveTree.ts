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
