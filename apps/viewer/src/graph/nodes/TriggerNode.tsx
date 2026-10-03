import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { FlowNodeData } from "../build";
import { triggerTitle } from "../labels";
import { triggerLink } from "../links";
import { sameNodeProps } from "../sameData";
import { LINK_NODE_TITLE_MAX_CHARS, TRIGGER_SIZE } from "../sizes";
import { NodeLink } from "./NodeLink";

function TriggerNodeImpl({ data }: NodeProps) {
  const d = data as unknown as Extract<FlowNodeData, { kind: "trigger" }>;
  const url = triggerLink(d.trigger);
  return (
    <div className="flow-node trigger" style={{ width: TRIGGER_SIZE.width, height: TRIGGER_SIZE.height }}>
      <div className="node-head">
        <span className="node-title" title={d.label}>
          {triggerTitle(d.trigger, d.label, LINK_NODE_TITLE_MAX_CHARS)}
        </span>
        {url && <NodeLink url={url} label={d.label} />}
      </div>
      <Handle type="source" position={Position.Right} className="flow-handle" isConnectable={false} />
    </div>
  );
}

export const TriggerNode = memo(TriggerNodeImpl, sameNodeProps);
