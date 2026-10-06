import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { Outcome } from "../../api/types";
import type { FlowNodeData } from "../build";
import { sameNodeProps } from "../sameData";
import { compactTarget } from "../labels";
import { outcomeLink } from "../links";
import { LINK_NODE_TITLE_MAX_CHARS, OUTCOME_SIZE, tailTruncate } from "../sizes";
import { NodeLink } from "./NodeLink";
import { formatEventTime } from "../../format/time";

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

/** A node's short title (repository owner dropped, number kept) and its second line. */
export function outcomeNodeText(o: Outcome, max: number): { title: string; detail: string } {
  const target = (repository: string, number: number | null) => compactTarget(repository, number, max - 2);
  switch (o.kind) {
    case "pull_request":
      return {
        title: `⎇ ${target(o.repository, o.number)}`,
        detail: o.state ? `pull request · ${o.state}` : "pull request",
      };
    case "code_host_comment":
      return { title: `💬 ${target(o.repository, o.number)}`, detail: "comment" };
    case "issue_comment":
      return { title: `💬 ${tailTruncate(o.issueKey, max - 2)}`, detail: "comment" };
    case "check":
      return {
        title: `${o.completed ? "✓" : "◌"} ${target(o.repository, o.number)}`,
        detail: `check · ${o.completed ? "completed" : "pending"}`,
      };
  }
}

function OutcomeNodeImpl({ data }: NodeProps) {
  const d = data as unknown as Extract<FlowNodeData, { kind: "outcome" }>;
  const { label } = outcomeLabel(d.outcome);
  const { title, detail } = outcomeNodeText(d.outcome, LINK_NODE_TITLE_MAX_CHARS);
  const url = outcomeLink(d.outcome);
  return (
    <div className="flow-node outcome" style={{ width: OUTCOME_SIZE.width, height: OUTCOME_SIZE.height }}>
      <Handle type="target" position={Position.Left} className="flow-handle" isConnectable={false} />
      <div className="node-head">
        <span className="node-title" title={label}>
          {title}
        </span>
        {url && <NodeLink url={url} label={label} />}
      </div>
      <span className="node-sub">
        {detail}
        {d.outcome.at && (
          <>
            {" · "}
            <time dateTime={d.outcome.at} title={new Date(d.outcome.at).toLocaleString()}>
              {formatEventTime(Date.parse(d.outcome.at))}
            </time>
          </>
        )}
      </span>
      {/* A pull request's review, mention or fix chains on from here (graph/chain.ts). */}
      <Handle type="source" position={Position.Right} className="flow-handle" isConnectable={false} />
    </div>
  );
}

export const OutcomeNode = memo(OutcomeNodeImpl, sameNodeProps);
