import { useEffect, useMemo, useRef } from "react";
import { select } from "d3-selection";
// Side-effect import: patches Selection with .transition() for animated pans.
import "d3-transition";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { line, curveCatmullRom } from "d3-shape";
import type { ChronoNode } from "../types";
import type { Journey, Turn } from "../turns";

export interface JourneyMapProps {
  journeys: Journey[];
  selectedTurnId: string | null;
  onSelectTurn: (id: string | null) => void;
  onSelectNode: (id: string) => void;
  selectedNodeId: string | null;
  /** null = search inactive; otherwise turn ids containing a match. */
  matchedTurnIds: Set<string> | null;
  /** When lens/flagged emphasis is on, waypoints without signal fade. */
  emphasizeSignal: boolean;
  focusTurnId: string | null;
  focusNonce: number;
}

const MARGIN_LEFT = 90;
const WAYPOINT_GAP = 200;
/** Long journeys fold serpentine across the sheet, like a route on a map. */
const TURNS_PER_ROW = 10;
const ROW_HEIGHT = 118;
const BAND_TOP = 96;
const BAND_PAD = 110;
/** Gentle hand-drawn wander of the trail inside its row. */
function wander(i: number): number {
  return Math.sin(i * 1.1) * 14 + Math.sin(i * 0.37) * 6;
}

function waypointRadius(turn: Turn): number {
  return 13 + Math.min(11, Math.sqrt(turn.nodes.length) * 2.2);
}

interface Placed {
  turn: Turn;
  journey: Journey;
  x: number;
  y: number;
  r: number;
}

const trailLine = line<{ x: number; y: number }>()
  .x((d) => d.x)
  .y((d) => d.y)
  .curve(curveCatmullRom.alpha(0.6));

/** Deterministic faint contour lines — the paper's topography. */
function contourPaths(width: number, height: number): string[] {
  const paths: string[] = [];
  for (let c = 0; c < 5; c++) {
    const baseY = (height / 5) * c + 40 + (c % 2) * 25;
    const pts: Array<{ x: number; y: number }> = [];
    for (let x = -80; x <= width + 80; x += 120) {
      pts.push({ x, y: baseY + Math.sin(x / 240 + c * 1.7) * 26 + Math.cos(x / 90 + c) * 9 });
    }
    const d = trailLine(pts);
    if (d) paths.push(d);
  }
  return paths;
}

export function JourneyMap({
  journeys,
  selectedTurnId,
  onSelectTurn,
  onSelectNode,
  selectedNodeId,
  matchedTurnIds,
  emphasizeSignal,
  focusTurnId,
  focusNonce,
}: JourneyMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<SVGGElement | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const didFitRef = useRef(false);

  const { placed, bandTops, mapWidth, mapHeight } = useMemo(() => {
    const all: Placed[] = [];
    const tops = new Map<string, number>();
    let y = BAND_TOP;
    for (const journey of journeys) {
      tops.set(journey.sessionId, y);
      journey.turns.forEach((turn, i) => {
        const row = Math.floor(i / TURNS_PER_ROW);
        const colRaw = i % TURNS_PER_ROW;
        // Serpentine: even rows run left→right, odd rows fold back right→left
        // — a long journey stays one readable sheet instead of a mile-wide strip.
        const col = row % 2 === 0 ? colRaw : TURNS_PER_ROW - 1 - colRaw;
        all.push({
          turn,
          journey,
          x: MARGIN_LEFT + col * WAYPOINT_GAP,
          y: y + row * ROW_HEIGHT + wander(i),
          r: waypointRadius(turn),
        });
      });
      const rows = Math.max(1, Math.ceil(journey.turns.length / TURNS_PER_ROW));
      y += rows * ROW_HEIGHT + BAND_PAD;
    }
    return {
      placed: all,
      bandTops: tops,
      mapWidth: MARGIN_LEFT + TURNS_PER_ROW * WAYPOINT_GAP + 60,
      mapHeight: y,
    };
  }, [journeys]);

  const byTurnId = useMemo(() => new Map(placed.map((p) => [p.turn.id, p])), [placed]);
  const contours = useMemo(() => contourPaths(mapWidth, mapHeight), [mapWidth, mapHeight]);

  const selectedTurn = selectedTurnId ? (byTurnId.get(selectedTurnId)?.turn ?? null) : null;

  useEffect(() => {
    const svg = svgRef.current;
    const viewport = viewportRef.current;
    if (!svg || !viewport) return;
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 2.5])
      .on("zoom", (event) => viewport.setAttribute("transform", event.transform.toString()));
    zoomRef.current = behavior;
    select(svg).call(behavior).on("dblclick.zoom", null);
    return () => {
      select(svg).on(".zoom", null);
      zoomRef.current = null;
    };
  }, []);

  function fitView() {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior || placed.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const pad = 40;
    const scale = Math.min(
      1.4,
      Math.max(0.12, Math.min((rect.width - pad) / mapWidth, (rect.height - pad) / mapHeight)),
    );
    const tx = (rect.width - mapWidth * scale) / 2;
    const ty = Math.max(8, (rect.height - mapHeight * scale) / 2);
    select(svg).call(behavior.transform, zoomIdentity.translate(tx, ty).scale(scale));
  }

  function zoomBy(factor: number) {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior) return;
    select(svg).transition().duration(150).call(behavior.scaleBy, factor);
  }

  useEffect(() => {
    if (!didFitRef.current && placed.length > 0) {
      didFitRef.current = true;
      fitView();
    }
    if (placed.length === 0) didFitRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed.length]);

  useEffect(() => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior || !focusTurnId) return;
    const p = byTurnId.get(focusTurnId);
    if (!p) return;
    const rect = svg.getBoundingClientRect();
    const scale = 1;
    select(svg)
      .transition()
      .duration(300)
      .call(
        behavior.transform,
        zoomIdentity.translate(rect.width / 2 - p.x * scale, rect.height / 2 - p.y * scale).scale(scale),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTurnId, focusNonce]);

  function turnFaded(turn: Turn): boolean {
    if (matchedTurnIds !== null) return !matchedTurnIds.has(turn.id);
    if (emphasizeSignal) return turn.verifiedCount + turn.advisoryCount === 0 && turn.marks.length === 0;
    return false;
  }

  return (
    <div className="map-pane" data-testid="journey-map">
      {journeys.length === 0 && (
        <div className="graph-empty-overlay">
          <p>No journeys charted yet.</p>
          <p className="graph-empty-hint">
            Work in Claude Code with the daemon running — each session becomes a trail here.
          </p>
        </div>
      )}
      <svg ref={svgRef} className="map-svg" role="img" aria-label="Session journey map">
        <g ref={viewportRef}>
          <g className="map-contours">
            {contours.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>

          {journeys.map((journey) => {
            const bandPlaced = placed.filter((p) => p.journey.sessionId === journey.sessionId);
            const routeClass = `map-route map-route-${journey.cli}`;
            const started = new Date(journey.startedAt);
            const bandTop = bandTops.get(journey.sessionId) ?? BAND_TOP;
            return (
              <g key={journey.sessionId}>
                <text className="map-session-label" x={MARGIN_LEFT - 66} y={bandTop - 58}>
                  {journey.cli} session · {started.toLocaleDateString()}{" "}
                  {started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </text>
                <text className="map-session-sub" x={MARGIN_LEFT - 66} y={bandTop - 42}>
                  {journey.turns.length} turns · {journey.nodeCount} steps
                </text>
                <line
                  className="map-band-rule"
                  x1={MARGIN_LEFT - 66}
                  x2={mapWidth - 60}
                  y1={bandTop - 34}
                  y2={bandTop - 34}
                />
                {/* Trail segments — thickness = the arriving turn's tool activity. */}
                {bandPlaced.slice(1).map((p, i) => {
                  const prev = bandPlaced[i]!;
                  const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 + 10 };
                  const d = trailLine([prev, mid, p]) ?? "";
                  const faded = turnFaded(p.turn) && turnFaded(prev.turn);
                  return (
                    <path
                      key={p.turn.id}
                      d={d}
                      className={`${routeClass}${faded ? " faded" : ""}`}
                      style={{ strokeWidth: 2 + Math.min(5, p.turn.toolCount * 0.6) }}
                    />
                  );
                })}
              </g>
            );
          })}

          {placed.map((p) => {
            const { turn } = p;
            const faded = turnFaded(turn);
            const isSelected = turn.id === selectedTurnId;
            const isMatch = matchedTurnIds?.has(turn.id) ?? false;
            return (
              <g
                key={turn.id}
                className={[
                  "map-waypoint",
                  `map-waypoint-${p.journey.cli}`,
                  isSelected ? "selected" : "",
                  faded ? "faded" : "",
                  isMatch ? "match" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                transform={`translate(${p.x}, ${p.y})`}
                onClick={() => onSelectTurn(isSelected ? null : turn.id)}
                data-testid="map-waypoint"
              >
                <title>
                  {`Turn ${turn.index} — ${turn.ask}\n${turn.toolCount} tool calls${
                    turn.toolNames.length ? ` (${turn.toolNames.join(", ")})` : ""
                  }${turn.verifiedCount ? `\n⚠ ${turn.verifiedCount} verified flag(s)` : ""}`}
                </title>
                <circle className="map-waypoint-ring" r={p.r} vectorEffect="non-scaling-stroke" />
                <text className="map-waypoint-number" dy="0.36em">
                  {turn.index}
                </text>
                {turn.verifiedCount > 0 && (
                  <g className="map-hazard" transform={`translate(${p.r * 0.75}, ${-p.r * 0.75})`}>
                    <circle r={9} />
                    <text dy="0.35em">{turn.verifiedCount}</text>
                  </g>
                )}
                {turn.advisoryCount > 0 && (
                  <g
                    className="map-advisory"
                    transform={`translate(${p.r * 0.95}, ${p.r * 0.55})`}
                  >
                    <circle r={7} />
                    <text dy="0.34em">{turn.advisoryCount}</text>
                  </g>
                )}
                {turn.marks.length > 0 && (
                  <path
                    className="map-pennant"
                    d={`M ${-p.r - 3} ${-p.r - 14} l 0 14 M ${-p.r - 3} ${-p.r - 14} l 12 4 l -12 4`}
                  />
                )}
                {turn.isHere && (
                  <g className="map-here" transform={`translate(0, ${-p.r - 16})`}>
                    <path d="M 0 8 C -6 0 -6 -6 0 -10 C 6 -6 6 0 0 8 Z" />
                    <circle cy={-4} r={2.2} />
                  </g>
                )}
                <text className="map-waypoint-ask" y={p.r + 16}>
                  {turn.ask.length > 34 ? `${turn.ask.slice(0, 33)}…` : turn.ask}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="graph-controls">
        <button aria-label="Zoom in" onClick={() => zoomBy(1.3)}>+</button>
        <button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>−</button>
        <button aria-label="Fit map to view" onClick={fitView}>fit</button>
      </div>

      {selectedTurn && (
        <div className="turn-drawer" data-testid="turn-drawer">
          <div className="turn-drawer-head">
            <span className="turn-drawer-title">
              Turn {selectedTurn.index} · {selectedTurn.ask}
            </span>
            <span className="turn-drawer-meta">
              {selectedTurn.toolCount} tool calls
              {selectedTurn.toolNames.length > 0 && ` · ${selectedTurn.toolNames.join(" · ")}`}
            </span>
            <button
              className="turn-drawer-close"
              aria-label="Close turn"
              onClick={() => onSelectTurn(null)}
            >
              ×
            </button>
          </div>
          <div className="turn-drawer-chips">
            {selectedTurn.nodes.map((node: ChronoNode) => {
              const active = (node.flags ?? []).filter((f) => !f.dismissed && !f.autoResolved);
              return (
                <button
                  key={node.id}
                  className={`turn-chip${node.id === selectedNodeId ? " selected" : ""}`}
                  onClick={() => onSelectNode(node.id)}
                  title={node.summary}
                >
                  <span className="legend-dot" style={{ background: `var(--kind-${node.kind})` }} />
                  <span className="turn-chip-kind">{node.kind.replace(/_/g, " ")}</span>
                  <span className="turn-chip-gist">{node.label ?? node.summary}</span>
                  {active.length > 0 && (
                    <span
                      className={`flag-badge flag-badge-${
                        active.some((f) => f.tier === "verified") ? "verified" : "advisory"
                      }`}
                    >
                      {active.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
