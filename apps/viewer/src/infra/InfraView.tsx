import { useMemo } from "react";
import { describe } from "./adapter";
import { InfraPanel } from "./InfraPanel";
import { InfraTable } from "./InfraTable";
import type { ClusterError } from "./types";
import type { UseCluster } from "./useCluster";

export type InfraMode = "map" | "table";

// Task 7 replaces this note with the real Map view.
const MAP_NOTE = "Map view arrives in the next step";

function errorText(error: ClusterError | { kind: string; message?: string }, namespace: string): string {
  const e = error as ClusterError;
  switch (e.kind) {
    case "no_kubeconfig":
      return "No kubeconfig found (~/.kube/config or $KUBECONFIG).";
    case "auth_plugin":
      return `Your cluster sign-in failed: ${e.message}. Run your cloud's login (e.g. \`gcloud auth login\`) and retry.`;
    case "forbidden":
      return `Your Kubernetes account can't list ${e.resource} in ${namespace}. See the README for a read-only Role.`;
    case "namespace_not_found":
      return `Namespace ${e.namespace} was not found in this cluster.`;
    case "unreachable":
      return `Can't reach the cluster: ${e.message}`;
    case "context_not_found":
      return `Kube context ${e.context} was not found in your kubeconfig.`;
    default:
      return ("message" in e ? e.message : null) ?? "Something went wrong reading the cluster.";
  }
}

interface Props {
  cluster: UseCluster;
  mode: InfraMode;
  selectedPod: string | null;
  onSelectPod: (pod: string | null) => void;
  onOpenRun: (runSha: string) => void;
  onRetry: () => void;
}

export function InfraView({ cluster: c, mode, selectedPod, onSelectPod, onOpenRun, onRetry }: Props) {
  const { info, cluster, context } = c;
  const model = useMemo(() => (info?.kubernetes ? describe(cluster, info) : null), [cluster, info]);
  const jobFinishedAt = useMemo(
    () => new Map([...cluster.objects.job.values()].map((j) => [j.name, j.finishedAt])),
    [cluster.objects.job],
  );

  if (c.loading) return <p className="muted">Loading…</p>;
  const namespace = info?.kubernetes?.namespace ?? "";
  const error = c.error ?? cluster.kindErrors.pod ?? (cluster.connected ? null : cluster.error);
  if (error) {
    return (
      <div className="infra-message">
        <p role="alert" className="error">
          {errorText(error, namespace)}
        </p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (info && info.launcher !== "kubernetes") {
    return (
      <p className="muted">This deployment runs coding jobs with Docker / locally, so there is no cluster to show.</p>
    );
  }
  if (!model || !context) return <p className="muted">Loading…</p>;

  const pods = [...model.groups.alwaysOn, ...model.groups.codingRuns, ...model.groups.jobs];
  const pod = pods.find((p) => p.name === selectedPod);

  return (
    <div className="workspace infra-workspace">
      <div className="infra-main">
        {mode === "map" && <p className="muted">{MAP_NOTE}</p>}
        <InfraTable
          model={model}
          selected={selectedPod}
          onSelect={(name) => onSelectPod(name === selectedPod ? null : name)}
          onOpenRun={onOpenRun}
          jobFinishedAt={jobFinishedAt}
        />
      </div>
      {pod && (
        <InfraPanel
          pod={pod}
          egressRules={model.isolation.egressRules}
          context={context}
          namespace={namespace}
          onOpenRun={onOpenRun}
          onClose={() => onSelectPod(null)}
        />
      )}
    </div>
  );
}
