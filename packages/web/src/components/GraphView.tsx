import { useMemo } from "react";
import ReactFlow, { Background, Controls, type EdgeTypes, type NodeTypes } from "reactflow";
import "reactflow/dist/style.css";
import { toReactFlowElements } from "../layout";
import type { ChronoNode } from "../types";
import { SojournNode, type SojournNodeData } from "./SojournNode";

export interface GraphViewProps {
  nodes: ChronoNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}

const nodeTypes: NodeTypes = { sojournNode: SojournNode };
const edgeTypes: EdgeTypes = {};

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

export function GraphView({ nodes, selectedNodeId, onSelectNode }: GraphViewProps) {
  const hereIds = useMemo(() => computeHereIds(nodes), [nodes]);

  const { flowNodes, flowEdges } = useMemo(() => {
    const { flowNodes, flowEdges } = toReactFlowElements(nodes);
    const withData = flowNodes.map((n) => ({
      ...n,
      selected: n.id === selectedNodeId,
      data: {
        ...(n.data as SojournNodeData),
        isHere: hereIds.has(n.id),
      },
    }));
    return { flowNodes: withData, flowEdges };
  }, [nodes, hereIds, selectedNodeId]);

  return (
    <div className="graph-pane" data-testid="graph-view">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#2a313c" gap={24} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
