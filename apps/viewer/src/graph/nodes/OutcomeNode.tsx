import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { Outcome } from "../../api/types";
import type { FlowNodeData } from "../build";
import { sameNodeProps } from "../sameData";

export function outcomeLabel(o: Outcome): { label: string; detail: string | null } {
  switch (o.kind) {
    case "pull_request":
      return { label: `⎇ ${o.repository}#${o.number}`, detail: o.state };
    case "code_host_comment":
      return { label: `💬 ${o.repository}#${o.number}`, detail: "comment" };
    case "issue_comment":
      return { label: `💬 ${o.issueKey}`, detail: "comment" };
    case "check":
      return {
        label: `${o.completed ? "✓" : "◌"} check ${o.repository}${o.number === null ? "" : `#${o.number}`}`,
        detail: o.completed ? "completed" : "pending",
      };
  }
}

function OutcomeNodeImpl({ data }: NodeProps) {
  const d = data as unknown as Extract<FlowNodeData, { kind: "outcome" }>;
  const { label, detail } = outcomeLabel(d.outcome);
  return (
    <div className="flow-node outcome">
      <Handle type="target" position={Position.Left} className="flow-handle" isConnectable={false} />
      <span className="node-title">{label}</span>
      {detail && <span className="node-sub">{detail}</span>}
    </div>
  );
}

export const OutcomeNode = memo(OutcomeNodeImpl, sameNodeProps);
