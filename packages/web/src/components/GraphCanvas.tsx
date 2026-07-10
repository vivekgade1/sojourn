import { useEffect, useMemo, useRef, useState } from "react";
import { select } from "d3-selection";
// Side-effect import: patches d3-selection's Selection with .transition(),
// which the pan/zoom animations below rely on.
import "d3-transition";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { linkHorizontal } from "d3-shape";
import { layoutGraph, trailOf, NODE_HEIGHT, NODE_WIDTH } from "../layout";
import type { ChronoNode } from "../types";
import { SojournNode } from "./SojournNode";

export interface GraphCanvasProps {
  nodes: ChronoNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  /** null = search inactive; a Set (possibly empty) = search active. */
  searchHits: Set<string> | null;
  /** Node to pan the viewport to; nonce re-triggers pans to the same node. */
  focusNodeId: string | null;
  focusNonce: number;
}

const link = linkHorizontal<unknown, { x: number; y: number }>()
  .x((d) => d.x)
  .y((d) => d.y);

/** Latest node (by timestamp) per sessionId gets the "you are here" marker. */
function computeHereIds(nodes: ChronoNode[]): Set<string> {
  const latestBySession = new Map<string, ChronoNode>();
  for (const node of nodes) {
    const current = latestBySession.get(node.sessionId);
    if (!current || new Date(node.timestamp).getTime() > new Date(current.timestamp).getTime()) {
      latestBySession.set(node.sessionId, node);
    }
  }
  return new Set([...latestBySession.values()].map((n) => n.id));
}

/**
 * The graph pane: a d3-zoomable SVG rendering the left→right session trees.
 * Hovering or selecting a node lights its whole lineage (the trail) in gold;
 * an active search dims everything that doesn't match.
 */
export function GraphCanvas({
  nodes,
  selectedNodeId,
  onSelectNode,
  searchHits,
  focusNodeId,
  focusNonce,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<SVGGElement | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const didFitRef = useRef(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const layout = useMemo(() => layoutGraph(nodes), [nodes]);
  const hereIds = useMemo(() => computeHereIds(nodes), [nodes]);
  const trail = useMemo(
    () => new Set(trailOf(hoveredId ?? selectedNodeId, nodes)),
    [hoveredId, selectedNodeId, nodes],
  );
  const trailActive = trail.size > 0;

  // Pan/zoom: d3-zoom drives the viewport <g> transform directly (no React
  // re-render per wheel event).
  useEffect(() => {
    const svg = svgRef.current;
    const viewport = viewportRef.current;
    if (!svg || !viewport) return;
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 2.5])
      .on("zoom", (event) => {
        viewport.setAttribute("transform", event.transform.toString());
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
    if (!svg || !behavior || layout.width === 0) return;
    const rect = svg.getBoundingClientRect();
    const pad = 48;
    const scale = Math.min(
      2,
      Math.max(0.15, Math.min((rect.width - pad) / layout.width, (rect.height - pad) / layout.height)),
    );
    const tx = (rect.width - layout.width * scale) / 2;
    const ty = (rect.height - layout.height * scale) / 2;
    select(svg).call(behavior.transform, zoomIdentity.translate(tx, ty).scale(scale));
  }

  function zoomBy(factor: number) {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior) return;
    select(svg).transition().duration(150).call(behavior.scaleBy, factor);
  }

  // Fit once, when the first non-empty layout arrives for this canvas.
  useEffect(() => {
    if (!didFitRef.current && nodes.length > 0) {
      didFitRef.current = true;
      fitView();
    }
    if (nodes.length === 0) didFitRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length]);

  // Pan to the focused node (search navigation / path breadcrumb clicks).
  useEffect(() => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior || !focusNodeId) return;
    const pos = layout.positions.get(focusNodeId);
    if (!pos) return;
    const rect = svg.getBoundingClientRect();
    const scale = 0.9;
    const tx = rect.width / 2 - (pos.x + NODE_WIDTH / 2) * scale;
    const ty = rect.height / 2 - (pos.y + NODE_HEIGHT / 2) * scale;
    select(svg)
      .transition()
      .duration(300)
      .call(behavior.transform, zoomIdentity.translate(tx, ty).scale(scale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId, focusNonce]);

  return (
    <div className="graph-pane" data-testid="graph-view">
      {nodes.length === 0 && (
        <div className="graph-empty-overlay">
          <p>No nodes captured yet.</p>
          <p className="graph-empty-hint">
            Work in Claude Code with the daemon running — prompts, tool calls, and decisions
            appear here live.
          </p>
        </div>
      )}
      <svg ref={svgRef} className="graph-svg" role="tree" aria-label="Session decision graph">
        <g ref={viewportRef}>
          <g className="graph-edges">
            {layout.edges.map((e) => {
              const s = layout.positions.get(e.source);
              const t = layout.positions.get(e.target);
              if (!s || !t) return null;
              const onTrail = trail.has(e.source) && trail.has(e.target);
              const d =
                link({
                  source: { x: s.x + NODE_WIDTH, y: s.y + NODE_HEIGHT / 2 },
                  target: { x: t.x, y: t.y + NODE_HEIGHT / 2 },
                } as never) ?? "";
              return (
                <path
                  key={e.id}
                  d={d}
                  className={`graph-edge${onTrail ? " on-trail" : ""}${
                    trailActive && !onTrail ? " receded" : ""
                  }`}
                />
              );
            })}
          </g>
          <g className="graph-nodes">
            {nodes.map((node) => {
              const pos = layout.positions.get(node.id);
              if (!pos) return null;
              const onTrail = trail.has(node.id);
              const searchActive = searchHits !== null;
              const isHit = searchActive && searchHits.has(node.id);
              const dimmed = searchActive && !isHit;
              const receded = !searchActive && trailActive && !onTrail;
              return (
                <foreignObject
                  key={node.id}
                  x={pos.x}
                  y={pos.y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  className="graph-node-fo"
                  onClick={() => onSelectNode(node.id)}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((h) => (h === node.id ? null : h))}
                >
                  <SojournNode
                    node={node}
                    selected={node.id === selectedNodeId}
                    isHere={hereIds.has(node.id)}
                    onTrail={onTrail}
                    dimmed={dimmed}
                    receded={receded}
                    searchHit={isHit}
                  />
                </foreignObject>
              );
            })}
          </g>
        </g>
      </svg>
      <div className="graph-controls">
        <button aria-label="Zoom in" onClick={() => zoomBy(1.3)}>+</button>
        <button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>−</button>
        <button aria-label="Fit graph to view" onClick={fitView}>fit</button>
      </div>
    </div>
  );
}
