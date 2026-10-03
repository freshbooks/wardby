import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useState } from "react";
import { useClock } from "../clock";
import type { GraphRun, ServiceStatus } from "../../api/types";
import { statusGroup } from "../../state/filters";
import type { FlowNodeData } from "../build";
import { sameNodeProps } from "../sameData";
import { RUN_TITLE_MAX_CHARS, RUN_WIDTH, runHeight, tailTruncate } from "../sizes";
import { exactUsd, formatUsd } from "../../format/money";

const FADE_AFTER_MS = 60_000;

export function statusGlyph(status: GraphRun["status"]): string {
  switch (statusGroup(status)) {
    case "running":
      return "◉";
    case "succeeded":
      return "✓";
    case "failed":
      return "✗";
    case "pending":
      return "◌";
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function serviceChip(s: ServiceStatus): string {
  switch (s.state) {
    case "ready":
      return "● ready";
    case "probing":
      return s.attempts === null ? "◐ probing" : `◐ probing ${s.attempts}`;
    case "pending":
      return "○ pending";
    case "failed":
      return s.reason ? `✗ failed (${s.reason})` : "✗ failed";
  }
}

/** True once a succeeded run has been finished for 60 s (one timer, no polling). */
function useFaded(run: GraphRun): boolean {
  const fadeAt = run.status === "succeeded" && run.finishedAt ? Date.parse(run.finishedAt) + FADE_AFTER_MS : null;
  const [fired, setFired] = useState(() => fadeAt !== null && Date.now() >= fadeAt);
  useEffect(() => {
    if (fadeAt === null) return;
    const id = setTimeout(() => setFired(true), Math.max(0, fadeAt - Date.now()));
    return () => clearTimeout(id);
  }, [fadeAt]);
  return fired && fadeAt !== null;
}

function RunNodeImpl({ data }: NodeProps) {
  const { run, selected } = data as unknown as Extract<FlowNodeData, { kind: "run" }>;
  const running = run.status === "running";
  const now = useClock(running);
  const faded = useFaded(run);
  const group = statusGroup(run.status);
  const pct = run.budgetUsd > 0 ? Math.min(100, (run.costUsd / run.budgetUsd) * 100) : 0;
  const cls = ["flow-node", "run", group, selected ? "selected" : "", faded ? "faded" : "", running ? "pulse" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} style={{ width: RUN_WIDTH, height: runHeight(run.services.length) }}>
      <Handle type="target" position={Position.Left} className="flow-handle" isConnectable={false} />
      <div className="node-head">
        <span className="glyph" role="img" aria-label={run.status}>
          {statusGlyph(run.status)}
        </span>
        <span className="node-title" title={run.agentName} aria-label={run.agentName}>
          {tailTruncate(run.agentName, RUN_TITLE_MAX_CHARS)}
        </span>
        <span className="node-id">{run.id.slice(-6)}</span>
      </div>
      <div className="node-sub" title={exactUsd(run.costUsd)}>
        turn {run.turns} · {formatUsd(run.costUsd)}
        {running && <span> · {formatElapsed(now - Date.parse(run.startedAt))}</span>}
      </div>
      <div
        className="budget"
        role="progressbar"
        aria-label="Budget used"
        aria-valuemin={0}
        aria-valuemax={run.budgetUsd > 0 ? run.budgetUsd : undefined}
        aria-valuenow={run.budgetUsd > 0 ? Math.min(run.costUsd, run.budgetUsd) : undefined}
      >
        <div style={{ width: `${pct}%` }} />
      </div>
      {run.services.length > 0 && (
        <ul className="chips" aria-label="Services">
          {run.services.map((s) => (
            <li key={s.name} className={`chip ${s.state}`} title={`${s.name} ${serviceChip(s)}`}>
              {s.name} {serviceChip(s)}
            </li>
          ))}
        </ul>
      )}
      <Handle type="source" position={Position.Right} className="flow-handle" isConnectable={false} />
    </div>
  );
}

export const RunNode = memo(RunNodeImpl, sameNodeProps);
