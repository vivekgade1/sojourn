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

/**
 * "Actionable" for the Restorable filter: a restore AT this node is provably
 * possible. Uses the server-computed `restorable` field (own snapshot, else the
 * nearest ancestor's, still exists) — NOT the node's own snapshot, so a node
 * with no snapshot of its own is still actionable when an ancestor's survives.
 *
 * Deliberately STRICT about absence: a MISSING `restorable` field is treated as
 * NOT actionable. This is the opposite default from `isRestoreReady`'s
 * backward-safe "absence = unknown-safe, still show the marker" — and
 * intentionally so. The marker views must never hide restore on old payloads;
 * this explicit "show only what can be restored" filter must never claim an
 * unverified node is restorable. Absence flips per JOB, not globally.
 */
export function isActionable(node: Pick<ChronoNode, "restorable">): boolean {
  return node.restorable === true;
}
