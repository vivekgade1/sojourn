import { useEffect, useMemo, useRef } from "react";
import { select } from "d3-selection";
// Side-effect import: patches Selection with .transition() for animated pans.
import "d3-transition";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { line, curveCatmullRom, arc as d3arc, pie as d3pie } from "d3-shape";
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

/**
 * The work ring: a thin donut around the waypoint number showing WHAT the
 * turn was made of — tool calls, assistant text, everything else. Order is
 * fixed (tool, assistant, other); identity is reinforced by the drawer's
 * labeled chips, never color alone.
 */
const RING_COLORS = ["var(--kind-tool_use)", "var(--kind-assistant)", "var(--border)"] as const;
const ringPie = d3pie<number>().sort(null).padAngle(0.06);

function workRingSegments(turn: Turn, r: number): Array<{ d: string; color: string }> {
  const assistantCount = turn.nodes.filter((n) => n.kind === "assistant").length;
  const other = Math.max(0, turn.nodes.length - turn.toolCount - assistantCount);
  const values = [turn.toolCount, assistantCount, other];
  if (values.every((v) => v === 0)) return [];
  const gen = d3arc<{ startAngle: number; endAngle: number; padAngle: number }>()
    .innerRadius(r + 2)
    .outerRadius(r + 6);
  return ringPie(values)
    .filter((slice) => slice.value > 0)
    .map((slice) => ({ d: gen(slice) ?? "", color: RING_COLORS[slice.index]! }));
}

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
  const minimapViewportRef = useRef<SVGRectElement | null>(null);
  const minimapScaleRef = useRef(1);

  // Direct-DOM sync (no React re-render per wheel event): the minimap's
  // viewport rectangle mirrors the main d3-zoom transform.
  function syncMinimapViewport(t: { k: number; x: number; y: number }) {
    const rectEl = minimapViewportRef.current;
    const svg = svgRef.current;
    if (!rectEl || !svg) return;
    const s = minimapScaleRef.current;
    const view = svg.getBoundingClientRect();
    rectEl.setAttribute("x", String(((0 - t.x) / t.k) * s));
    rectEl.setAttribute("y", String(((0 - t.y) / t.k) * s));
    rectEl.setAttribute("width", String((view.width / t.k) * s));
    rectEl.setAttribute("height", String((view.height / t.k) * s));
  }

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
      .on("zoom", (event) => {
        viewport.setAttribute("transform", event.transform.toString());
        syncMinimapViewport(event.transform as { k: number; x: number; y: number });
      });
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
    // Newest journey renders first (top of the sheet) — anchor the fit to the
    // TOP so "latest" is what you see, and fit width first for readability.
    const scale = Math.min(1.2, Math.max(0.12, (rect.width - pad) / mapWidth));
    const tx = (rect.width - mapWidth * scale) / 2;
    select(svg).call(behavior.transform, zoomIdentity.translate(tx, 16).scale(scale));
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

  const MINI_W = 180;
  const miniScale = Math.min(MINI_W / mapWidth, 130 / Math.max(1, mapHeight));
  const miniH = Math.max(24, mapHeight * miniScale);
  useEffect(() => {
    minimapScaleRef.current = miniScale;
  }, [miniScale]);

  function minimapJump(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior) return;
    const box = e.currentTarget.getBoundingClientRect();
    const wx = (e.clientX - box.left) / miniScale;
    const wy = (e.clientY - box.top) / miniScale;
    const view = svg.getBoundingClientRect();
    const k = 0.9;
    select(svg)
      .transition()
      .duration(250)
      .call(
        behavior.transform,
        zoomIdentity.translate(view.width / 2 - wx * k, view.height / 2 - wy * k).scale(k),
      );
  }

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
                  // Time direction as ink density: the trail darkens toward now.
                  const ramp =
                    0.4 + 0.6 * (bandPlaced.length > 2 ? i / (bandPlaced.length - 2) : 1);
                  return (
                    <path
                      key={p.turn.id}
                      d={d}
                      className={routeClass}
                      style={{
                        strokeWidth: 2 + Math.min(5, p.turn.toolCount * 0.6),
                        opacity: faded ? 0.12 : ramp,
                      }}
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
                  }${turn.verifiedCount ? `\n⚠ ${turn.verifiedCount} verified flag(s)` : ""}${
                    turn.hasRestorable ? `\n⤺ ${turn.restorableCount} restore point(s)` : ""
                  }${
                    turn.hasThinned
                      ? "\n⊘ a restore point here was thinned (soj gc) — unavailable"
                      : ""
                  }`}
                </title>
                <g
                  className="map-waypoint-inner"
                  style={{ animationDelay: `${Math.min(placed.indexOf(p) * 18, 500)}ms` }}
                >
                  <circle className="map-waypoint-ring" r={p.r} vectorEffect="non-scaling-stroke" />
                  {workRingSegments(turn, p.r).map((seg, si) => (
                    <path key={si} d={seg.d} fill={seg.color} className="map-work-ring" />
                  ))}
                  <text className="map-waypoint-number" dy="0.36em">
                    {turn.index}
                  </text>
                </g>
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
                {/* Restore anchor — a subtle dot at the lower-left, kept quiet
                    so the common all-restorable trail doesn't read as noise. */}
                {turn.hasRestorable && (
                  <circle
                    className="map-restore-dot"
                    cx={-p.r * 0.72}
                    cy={p.r * 0.72}
                    r={3}
                  />
                )}
                {/* Thinned/unavailable restore point — a muted open ring with a
                    slash, echoing the graph card's thinned glyph. Distinct from
                    the restore-ready dot; shares the lower-left "restore status"
                    corner but stacks just below it when both are present. */}
                {turn.hasThinned && (
                  <g
                    className="map-thinned"
                    data-testid="map-thinned"
                    transform={`translate(${-p.r * 0.72}, ${
                      p.r * 0.72 + (turn.hasRestorable ? 11 : 0)
                    })`}
                  >
                    <circle className="map-thinned-ring" r={3.4} />
                    <path className="map-thinned-slash" d="M -2.5 2.5 L 2.5 -2.5" />
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

      {placed.length > 0 && (
        <svg
          className="minimap"
          width={MINI_W}
          height={miniH}
          onClick={minimapJump}
          role="presentation"
          aria-hidden="true"
        >
          {placed.map((p) => (
            <circle
              key={p.turn.id}
              cx={p.x * miniScale}
              cy={p.y * miniScale}
              r={Math.max(1.4, p.r * miniScale)}
              className={`minimap-dot minimap-dot-${p.journey.cli}${
                p.turn.verifiedCount > 0 ? " hazard" : ""
              }`}
            />
          ))}
          <rect ref={minimapViewportRef} className="minimap-viewport" x={0} y={0} width={0} height={0} />
        </svg>
      )}

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
