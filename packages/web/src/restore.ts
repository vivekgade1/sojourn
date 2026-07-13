import type { ChronoNode } from "./types";

/**
 * A node is a "restore anchor" (restore-ready) iff it holds its OWN snapshot
 * AND that snapshot still exists. `restorable === false` means the snapshot was
 * thinned by retention (`soj gc`) or never captured — NOT restore-ready. A
 * MISSING `restorable` field is treated as unknown-safe (restore-ready), so
 * older graph payloads never lose their restore markers.
 *
 * Note: a node with no own snapshot may still be `restorable` via an ancestor's
 * snapshot (see ChronoNode.restorable), but it is not itself a restore ANCHOR —
 * the visual markers point at the actual snapshot-bearing points in the tree.
 */
export function isRestoreReady(node: Pick<ChronoNode, "snapshotRef" | "restorable">): boolean {
  return node.snapshotRef !== null && node.restorable !== false;
}

/**
 * A node whose snapshot was recorded but is no longer restorable — a former
 * restore point thinned by retention. Rendered as visibly unavailable.
 */
export function isThinned(node: Pick<ChronoNode, "snapshotRef" | "restorable">): boolean {
  return node.snapshotRef !== null && node.restorable === false;
}
