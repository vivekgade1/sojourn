import { Handle, Position, type NodeProps } from "reactflow";
import type { ChronoNode } from "../types";
import { FlagBadge } from "./FlagBadge";

export interface SojournNodeData {
  node: ChronoNode;
  isHere?: boolean;
}

const KIND_LABEL: Record<ChronoNode["kind"], string> = {
  prompt: "Prompt",
  assistant: "Assistant",
  tool_use: "Tool use",
  tool_result: "Tool result",
  decision: "Decision",
  assumption: "Assumption",
  fork_point: "Fork point",
  checkpoint: "Checkpoint",
};

export function SojournNode({ data, selected }: NodeProps<SojournNodeData>) {
  const { node, isHere } = data;
  const flags = node.flags ?? [];

  return (
    <div
      className={`sojourn-node sojourn-node-cli-${node.cli}${selected ? " selected" : ""}`}
      data-testid="sojourn-node"
      data-kind={node.kind}
      data-cli={node.cli}
    >
      <Handle type="target" position={Position.Top} />
      <div className="sojourn-node-kind-bar" style={{ background: `var(--kind-${node.kind})` }} />
      {isHere && <div className="sojourn-node-here">you are here</div>}
      <div className="sojourn-node-header">
        <span className="sojourn-node-kind" style={{ color: `var(--kind-${node.kind})` }}>
          {KIND_LABEL[node.kind]}
        </span>
        <FlagBadge flags={flags} />
      </div>
      <div className="sojourn-node-summary">{node.label ?? node.summary}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
