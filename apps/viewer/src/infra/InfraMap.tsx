import { useEffect, useState } from "react";
import type { InfraModel, PodView } from "./adapter";
import { containerDot } from "./format";
import { visibleJobs } from "./jobs";

interface Props {
  model: InfraModel;
  selected: string | null;
  onSelect: (pod: string) => void;
  onOpenRun: (runSha: string) => void;
  namespace?: string;
  jobFinishedAt?: ReadonlyMap<string, string | null>;
  now?: number;
}

const readyCount = (p: PodView) => `${p.containers.filter((c) => c.ready).length}/${p.containers.length}`;

function Containers({ pod }: { pod: PodView }) {
  return (
    <span className="map-containers">
      {pod.containers.map((c) => (
        <span key={c.name} className="map-container" title={`${c.name}: ${c.reason ?? c.state}`}>
          <span className={`infra-dot ${containerDot(c)}`} aria-hidden="true" />
          {c.name}
        </span>
      ))}
    </span>
  );
}

function PodCard({
  pod,
  selected,
  onSelect,
  compact,
}: {
  pod: PodView;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`map-card map-pod${compact ? " compact" : ""}`}
      aria-pressed={selected}
      title={pod.name}
      onClick={onSelect}
    >
      <span className="map-title">
        <span>{pod.title}</span>
        <span className="muted">{readyCount(pod)}</span>
      </span>
      {!compact && <Containers pod={pod} />}
      {!compact && pod.identity && <span className="muted map-identity">{pod.identity}</span>}
    </button>
  );
}

function Sandbox({
  pod,
  selected,
  onSelect,
  onOpenRun,
}: {
  pod: PodView;
  selected: boolean;
  onSelect: () => void;
  onOpenRun: (sha: string) => void;
}) {
  const label = `${pod.runtime ?? "Pod"} sandbox · ${pod.name}`;
  const sha = pod.runSha;
  return (
    <div className="map-sandbox" role="group" aria-label={label}>
      <span className="map-zone-label">{label}</span>
      <div className="map-sandbox-body">
        <button type="button" className="map-card map-pod" aria-pressed={selected} title={pod.name} onClick={onSelect}>
          <span className="map-title">
            <span>{pod.title}</span>
            <span className="muted">{readyCount(pod)}</span>
          </span>
          <Containers pod={pod} />
        </button>
        {sha && (
          <button
            type="button"
            className="infra-open-run"
            aria-label={`Open run ${pod.title}`}
            title="Open run"
            onClick={() => onOpenRun(sha)}
          >
            ↗
          </button>
        )}
      </div>
    </div>
  );
}

export function InfraMap({ model, selected, onSelect, onOpenRun, namespace, jobFinishedAt, now: fixedNow }: Props) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const { alwaysOn, codingRuns } = model.groups;
  const jobs = visibleJobs(model.groups.jobs, jobFinishedAt, fixedNow ?? clock);
  const hosts = [...new Set(model.edge.flatMap((e) => e.hosts))];
  const main = alwaysOn.filter((p) => p.title !== "headroom");
  const headroom = alwaysOn.filter((p) => p.title === "headroom");
  const rules = model.isolation.egressRules;
  const secrets = model.secrets;

  return (
    <div className="infra-map">
      <div className="map-col map-edge-col">
        <div className="map-card map-static map-flow">
          <span className="map-title">Internet</span>
          {hosts.map((h) => (
            <span key={h} className="muted">
              {h}
            </span>
          ))}
        </div>
        {model.edge.map((e, i) => (
          <div key={`${e.label}-${i}`} className="map-card map-static map-flow">
            <span className="map-title">{e.label}</span>
            {e.detail.length > 0 && <span className="muted">{e.detail.join(" · ")}</span>}
          </div>
        ))}
      </div>

      <div className="map-zone map-namespace">
        {namespace && <span className="map-zone-label">namespace {namespace}</span>}
        <div className="map-pods">
          {main.map((p) => (
            <PodCard key={p.name} pod={p} selected={selected === p.name} onSelect={() => onSelect(p.name)} />
          ))}
        </div>
        {(codingRuns.length > 0 || rules.length > 0) && (
          <div className="map-fence">
            {rules.length > 0 && <span className="map-zone-label">NetworkPolicy: {rules.join(", ")}</span>}
            <div className="map-sandboxes">
              {codingRuns.map((p) => (
                <Sandbox
                  key={p.name}
                  pod={p}
                  selected={selected === p.name}
                  onSelect={() => onSelect(p.name)}
                  onOpenRun={onOpenRun}
                />
              ))}
              {codingRuns.length === 0 && <span className="muted">No coding runs</span>}
            </div>
          </div>
        )}
        {headroom.length > 0 && (
          <div className="map-pods map-small">
            {headroom.map((p) => (
              <PodCard key={p.name} pod={p} compact selected={selected === p.name} onSelect={() => onSelect(p.name)} />
            ))}
          </div>
        )}
        {jobs.length > 0 && (
          <>
            <span className="map-zone-label">jobs</span>
            <div className="map-pods map-small">
              {jobs.map((p) => (
                <PodCard
                  key={p.name}
                  pod={p}
                  compact
                  selected={selected === p.name}
                  onSelect={() => onSelect(p.name)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="map-col map-data-col">
        {model.dataStores.map((d) => (
          <div key={d.label} className="map-card map-static">
            <span className="map-title">{d.label}</span>
            {d.detail.length > 0 && <span className="muted">{d.detail.join(" · ")}</span>}
          </div>
        ))}
        {(secrets.source || secrets.names === null) && (
          <div className="map-card map-static">
            <span className="map-title">
              {secrets.names === null
                ? "Secret names hidden (no access)"
                : `${secrets.source ?? "Secrets"} → ${secrets.names.length} Secrets`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
