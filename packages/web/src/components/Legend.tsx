import type { ChronoNode } from "../types";
import { KIND_LABEL } from "./SojournNode";

const KINDS = Object.keys(KIND_LABEL) as ChronoNode["kind"][];

export interface LegendProps {
  nodeCount: number;
  sessionCount: number;
}

/** Wayfinding strip: what the colors mean and how to read the edges. */
export function Legend({ nodeCount, sessionCount }: LegendProps) {
  return (
    <div className="legend" data-testid="legend">
      {KINDS.map((kind) => (
        <span key={kind} className="legend-chip">
          <span className="legend-dot" style={{ background: `var(--kind-${kind})` }} />
          {KIND_LABEL[kind]}
        </span>
      ))}
      <span className="legend-hint">
        time flows left → right · stacked nodes = parallel tool calls · hover a node to light its
        path
      </span>
      <span className="legend-count">
        {nodeCount} nodes · {sessionCount} session{sessionCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}
