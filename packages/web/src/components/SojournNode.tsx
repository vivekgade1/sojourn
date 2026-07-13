import type { ChronoNode } from "../types";
import { isRestoreReady, isThinned } from "../restore";
import { FlagBadge } from "./FlagBadge";

export interface SojournNodeProps {
  node: ChronoNode;
  selected?: boolean;
  isHere?: boolean;
  onTrail?: boolean;
  /** Strong dim: active search and this node doesn't match. */
  dimmed?: boolean;
  /** Soft dim: a trail is lit and this node isn't on it. */
  receded?: boolean;
  searchHit?: boolean;
  /**
   * The Restorable filter is active AND this node is actionable — paint the
   * distinct "action" (amber) treatment. Driven entirely by the caller so the
   * card stays dumb; see GraphCanvas for the `filterActive && isActionable`
   * gate. Rides a `::after` ring so it never clobbers the restore/trail/search
   * box-shadow cascade.
   */
  actionHighlight?: boolean;
}

export const KIND_LABEL: Record<ChronoNode["kind"], string> = {
  prompt: "Prompt",
  assistant: "Assistant",
  tool_use: "Tool use",
  tool_result: "Tool result",
  decision: "Decision",
  assumption: "Assumption",
  fork_point: "Fork point",
  checkpoint: "Checkpoint",
};

/** Compact card for one graph node. Full summary lives in the title tooltip. */
export function SojournNode({
  node,
  selected,
  isHere,
  onTrail,
  dimmed,
  receded,
  searchHit,
  actionHighlight,
}: SojournNodeProps) {
  const flags = node.flags ?? [];
  const gist = node.label ?? node.summary;
  // Restore markers key off the node's OWN snapshot: a snapshot-bearing node is
  // an actual rollback anchor. "restore-ready" and "thinned" are mutually
  // exclusive; nodes with no snapshot of their own get neither.
  const restoreReady = isRestoreReady(node);
  const thinned = isThinned(node);
  const classes = [
    "sojourn-node",
    `sojourn-node-cli-${node.cli}`,
    selected ? "selected" : "",
    onTrail ? "on-trail" : "",
    dimmed ? "dimmed" : "",
    receded ? "receded" : "",
    searchHit ? "search-hit" : "",
    restoreReady ? "restore-ready" : "",
    thinned ? "thinned" : "",
    actionHighlight ? "action-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      data-testid="sojourn-node"
      data-kind={node.kind}
      data-cli={node.cli}
      title={gist}
    >
      <div className="sojourn-node-kind-bar" style={{ background: `var(--kind-${node.kind})` }} />
      {isHere && <div className="sojourn-node-here">you are here</div>}
      {restoreReady && (
        <span className="sojourn-node-restore-dot" title="Restore point — a snapshot is captured here" />
      )}
      {thinned && (
        <span
          className="sojourn-node-thinned-mark"
          title="Snapshot thinned by retention (soj gc) — restore unavailable"
        />
      )}
      <div className="sojourn-node-header">
        <span className="sojourn-node-kind" style={{ color: `var(--kind-${node.kind})` }}>
          {KIND_LABEL[node.kind]}
        </span>
        <FlagBadge flags={flags} />
      </div>
      <div className="sojourn-node-summary">{gist}</div>
    </div>
  );
}
