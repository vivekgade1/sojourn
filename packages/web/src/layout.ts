import dagre from "@dagrejs/dagre";
import type { Edge, Node as FlowNode } from "reactflow";
import type { ChronoNode } from "./types";

export interface Position {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, Position>;
  edges: Array<{ id: string; source: string; target: string }>;
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 72;

/**
 * Lays out a set of ChronoNodes top-down using dagre: parents above children,
 * siblings side-by-side. Edges are derived from each node's parentId — a
 * parentId that doesn't match any node in the set is simply skipped (no edge
 * added), which also happens to be the "graph root" case.
 */
export function layoutGraph(nodes: ChronoNode[], direction: "TB" | "LR" = "TB"): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 90 });

  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const edges: Array<{ id: string; source: string; target: string }> = [];
  for (const node of nodes) {
    if (node.parentId && nodeIds.has(node.parentId)) {
      g.setEdge(node.parentId, node.id);
      edges.push({ id: `${node.parentId}->${node.id}`, source: node.parentId, target: node.id });
    }
  }

  dagre.layout(g);

  const positions = new Map<string, Position>();
  for (const node of nodes) {
    const laidOut = g.node(node.id);
    positions.set(node.id, { x: laidOut.x, y: laidOut.y });
  }

  return { positions, edges };
}

/** Converts ChronoNodes + layout into React Flow nodes/edges ready to render. */
export function toReactFlowElements(
  nodes: ChronoNode[],
  direction: "TB" | "LR" = "TB",
): { flowNodes: FlowNode[]; flowEdges: Edge[] } {
  const { positions, edges } = layoutGraph(nodes, direction);

  const flowNodes: FlowNode[] = nodes.map((node) => ({
    id: node.id,
    type: "sojournNode",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: { node },
  }));

  const flowEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
  }));

  return { flowNodes, flowEdges };
}
