import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";
import type { ChronoNode } from "./types";

export interface Position {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, Position>;
  edges: Array<{ id: string; source: string; target: string }>;
  /** Bounding box of the laid-out forest (for fit-to-view). */
  width: number;
  height: number;
}

export const NODE_WIDTH = 248;
export const NODE_HEIGHT = 60;
/** Horizontal distance between a parent column and its children column. */
export const COL_GAP = 320;
/** Vertical distance between sibling rows. */
export const ROW_GAP = 84;
/** Vertical padding between separate session trees. */
export const TREE_GAP = 120;

interface TreeDatum {
  node: ChronoNode | null; // null = synthetic root of a forest tree
  children: TreeDatum[];
}

/**
 * Lays the graph out as a left→right tidy tree (d3-hierarchy): time flows
 * left to right — a parent is always strictly LEFT of its children, and
 * siblings (e.g. parallel tool calls) stack vertically in the same column.
 * Nodes whose parentId is missing from the set are roots; each root's tree
 * is laid out independently and the trees are stacked vertically.
 *
 * Deterministic: roots and children are ordered by timestamp, then id.
 */
export function layoutGraph(nodes: ChronoNode[]): LayoutResult {
  const positions = new Map<string, Position>();
  const edges: Array<{ id: string; source: string; target: string }> = [];
  if (nodes.length === 0) return { positions, edges, width: 0, height: 0 };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, ChronoNode[]>();
  const roots: ChronoNode[] = [];

  const chrono = (a: ChronoNode, b: ChronoNode) =>
    a.timestamp === b.timestamp ? (a.id < b.id ? -1 : 1) : a.timestamp < b.timestamp ? -1 : 1;

  for (const node of [...nodes].sort(chrono)) {
    if (node.parentId && byId.has(node.parentId)) {
      const siblings = childrenOf.get(node.parentId) ?? [];
      siblings.push(node);
      childrenOf.set(node.parentId, siblings);
      edges.push({ id: `${node.parentId}->${node.id}`, source: node.parentId, target: node.id });
    } else {
      roots.push(node);
    }
  }

  const toDatum = (node: ChronoNode, seen: Set<string>): TreeDatum => ({
    node,
    children: (childrenOf.get(node.id) ?? [])
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .map((c) => toDatum(c, seen)),
  });

  const layoutTree = tree<TreeDatum>()
    // nodeSize is [vertical, horizontal] because we swap axes below (LR).
    .nodeSize([ROW_GAP, COL_GAP])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.25));

  let yOffset = 0;
  let maxX = 0;
  const seen = new Set<string>(roots.map((r) => r.id));

  for (const root of roots) {
    const laidOut = layoutTree(hierarchy(toDatum(root, seen)));

    let minRow = Infinity;
    let maxRow = -Infinity;
    let maxDepth = 0;
    laidOut.each((p: HierarchyPointNode<TreeDatum>) => {
      minRow = Math.min(minRow, p.x);
      maxRow = Math.max(maxRow, p.x);
      maxDepth = Math.max(maxDepth, p.y);
    });

    laidOut.each((p: HierarchyPointNode<TreeDatum>) => {
      if (!p.data.node) return;
      // Swap axes: depth (p.y) becomes horizontal, sibling spread (p.x) vertical.
      positions.set(p.data.node.id, { x: p.y, y: yOffset + (p.x - minRow) });
    });

    yOffset += maxRow - minRow + TREE_GAP;
    maxX = Math.max(maxX, maxDepth);
  }

  return {
    positions,
    edges,
    width: maxX + NODE_WIDTH,
    height: Math.max(0, yOffset - TREE_GAP) + NODE_HEIGHT,
  };
}

/**
 * The lineage of a node: its ancestor chain from the session root down to
 * (and including) the node itself — the "trail" the UI illuminates.
 * Cycle-guarded; unknown parent ids terminate the walk.
 */
export function trailOf(nodeId: string | null, nodes: ChronoNode[]): string[] {
  if (!nodeId) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trail: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(nodeId) ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.push(current.id);
    current = current.parentId ? (byId.get(current.parentId) ?? null) : null;
  }
  return trail.reverse();
}
