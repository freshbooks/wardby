import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { FlowNodeData } from "../build";
import { sameNodeProps } from "../sameData";

function TriggerNodeImpl({ data }: NodeProps) {
  const d = data as unknown as Extract<FlowNodeData, { kind: "trigger" }>;
  return (
    <div className="flow-node trigger">
      <span className="node-title">{d.label}</span>
      <Handle type="source" position={Position.Right} className="flow-handle" isConnectable={false} />
    </div>
  );
}

export const TriggerNode = memo(TriggerNodeImpl, sameNodeProps);
