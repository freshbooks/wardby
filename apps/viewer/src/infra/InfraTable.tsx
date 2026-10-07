import { useEffect, useState } from "react";
import type { InfraModel, PodView } from "./adapter";
import { containerDot, formatAge, podUsage, statusKind } from "./format";

const HOUR_MS = 3_600_000;

interface Props {
  model: InfraModel;
  selected: string | null;
  onSelect: (pod: string) => void;
  onOpenRun: (runSha: string) => void;
  /** Finish time by job name; a job finished over an hour ago is hidden. */
  jobFinishedAt?: ReadonlyMap<string, string | null>;
  now?: number;
}

function Row({
  pod,
  selected,
  onSelect,
  onOpenRun,
  now,
}: {
  pod: PodView;
  selected: boolean;
  onSelect: () => void;
  onOpenRun: (sha: string) => void;
  now: number;
}) {
  const sha = pod.runSha;
  return (
    <div className="infra-row-wrap" role="row">
      <button type="button" className="infra-row" aria-pressed={selected} onClick={onSelect}>
        <span className="infra-cell pod-name" role="cell" title={pod.name}>
          {pod.name}
        </span>
        <span className="infra-cell" role="cell">
          {pod.containers.map((c) => (
            <span key={c.name} className="infra-container" title={`${c.name}: ${c.reason ?? c.state}`}>
              <span className={`infra-dot ${containerDot(c)}`} aria-hidden="true" />
              {c.name}
            </span>
          ))}
        </span>
        <span className={`infra-cell status ${statusKind(pod)}`} role="cell">
          {pod.status}
          {pod.runtime && <span className="muted"> · {pod.runtime}</span>}
        </span>
        <span className="infra-cell" role="cell">
          {podUsage(pod)}
        </span>
        <span className="infra-cell" role="cell">
          {formatAge(pod.startedAt, now)}
        </span>
      </button>
      {sha && (
        <button
          type="button"
          className="infra-open-run"
          aria-label="Open run"
          title="Open run"
          onClick={() => onOpenRun(sha)}
        >
          ↗
        </button>
      )}
    </div>
  );
}

export function InfraTable({ model, selected, onSelect, onOpenRun, jobFinishedAt, now: fixedNow }: Props) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const now = fixedNow ?? clock;
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const keep = (p: PodView) => !q || `${p.name} ${p.title} ${p.status}`.toLowerCase().includes(q);
  const recentJob = (p: PodView) => {
    const finished = jobFinishedAt?.get(p.title);
    return !finished || now - Date.parse(finished) <= HOUR_MS;
  };
  const sections: [string, PodView[]][] = [
    ["ALWAYS ON", model.groups.alwaysOn],
    ["CODING RUNS", model.groups.codingRuns],
    ["JOBS", model.groups.jobs.filter(recentJob)],
  ];

  return (
    <div className="infra-table">
      <input
        type="search"
        aria-label="Filter pods"
        placeholder="filter pods…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div role="table" aria-label="Pods">
        <div className="infra-head" role="row">
          {["Pod", "Containers", "Status", "CPU / Mem", "Age"].map((h) => (
            <span key={h} role="columnheader">
              {h}
            </span>
          ))}
        </div>
        {sections.map(([title, pods]) => {
          const rows = pods.filter(keep);
          return (
            <div key={title} role="rowgroup">
              <h3 className="infra-group">{title}</h3>
              {rows.length === 0 && <p className="muted infra-empty">None</p>}
              {rows.map((p) => (
                <Row
                  key={p.name}
                  pod={p}
                  selected={selected === p.name}
                  onSelect={() => onSelect(p.name)}
                  onOpenRun={onOpenRun}
                  now={now}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
