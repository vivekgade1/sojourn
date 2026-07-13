import type { ChronoNode } from "../types";
import { KIND_LABEL } from "./SojournNode";

const KINDS = Object.keys(KIND_LABEL) as ChronoNode["kind"][];

export interface LegendProps {
  /** Steps within the SELECTED sessions (what's actually on screen). */
  nodeCount: number;
  /** Selected session count. */
  sessionCount: number;
  /** Total sessions in the project — keeps the count honest under filtering. */
  totalSessionCount: number;
  view: "map" | "graph";
}

/** Wayfinding strip: what the marks mean and how to read the view. */
export function Legend({ nodeCount, sessionCount, totalSessionCount, view }: LegendProps) {
  return (
    <div className="legend" data-testid="legend">
      {view === "map" ? (
        <>
          <span className="legend-chip">
            <span className="legend-glyph legend-glyph-waypoint" />
            waypoint = one turn (sized by work)
          </span>
          <span className="legend-chip">
            <span className="legend-glyph legend-glyph-hazard" />
            verified flags
          </span>
          <span className="legend-chip">
            <span className="legend-glyph legend-glyph-advisory" />
            advisory
          </span>
          <span className="legend-chip">
            <span className="legend-glyph legend-glyph-pennant">⚑</span>
            decision / checkpoint
          </span>
          <span className="legend-chip">
            <span className="legend-glyph legend-glyph-restore" />
            restore point
          </span>
          <span className="legend-chip">
            <span className="legend-glyph legend-glyph-here" />
            you are here
          </span>
          <span className="legend-hint">
            each trail is a session · click a waypoint to open its turn
          </span>
        </>
      ) : (
        <>
          {KINDS.map((kind) => (
            <span key={kind} className="legend-chip">
              <span className="legend-dot" style={{ background: `var(--kind-${kind})` }} />
              {KIND_LABEL[kind]}
            </span>
          ))}
          <span className="legend-chip">
            <span className="legend-glyph legend-glyph-restore" />
            restore point
          </span>
          <span className="legend-hint">
            time flows left → right · stacked nodes = parallel tool calls · hover a node to light
            its path
          </span>
        </>
      )}
      <span className="legend-count">
        {nodeCount} steps ·{" "}
        {sessionCount === totalSessionCount
          ? `${totalSessionCount} session${totalSessionCount === 1 ? "" : "s"}`
          : `${sessionCount} of ${totalSessionCount} sessions`}
      </span>
    </div>
  );
}
