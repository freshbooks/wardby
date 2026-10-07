import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ServerSummary } from "../api/client";
import type { GraphRun } from "../api/types";
import type { InfraBar } from "../chrome/TopBar";
import { describe } from "./adapter";
import { platformLabel } from "./format";
import { InfraFooter } from "./InfraFooter";
import { InfraView, type InfraMode } from "./InfraView";
import { runSha } from "./runSha";
import { useCluster } from "./useCluster";
import { platformOf } from "./adapter";

interface Props {
  server: ServerSummary;
  runs: readonly GraphRun[];
  /** The top bar, given the Infrastructure controls it should show. */
  topBar: (infra: InfraBar) => ReactNode;
  /** Switch to the Runs tab with this run selected. */
  onOpenRun: (runId: string) => void;
  onRetry: () => void;
}

/** The Infrastructure tab: owns the cluster watch, so it only runs while the tab is open. */
export function InfraScreen({ server, runs, topBar, onOpenRun, onRetry }: Props) {
  const cluster = useCluster(server);
  const [mode, setMode] = useState<InfraMode>("map");
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const { info } = cluster;
  const model = useMemo(
    () => (info?.kubernetes && !cluster.error ? describe(cluster.cluster, info) : null),
    [cluster.cluster, cluster.error, info],
  );
  const platform = info ? platformOf(info, cluster.cluster) : "generic";

  const openRun = useCallback(
    async (sha: string) => {
      const chars = info?.kubernetes?.runLabelHashChars ?? 40;
      for (const r of runs) {
        if ((await runSha(r.id, chars)) === sha) {
          setMissing(false);
          onOpenRun(r.id);
          return;
        }
      }
      setMissing(true);
    },
    [info, runs, onOpenRun],
  );

  return (
    <>
      {topBar({
        mode,
        onModeChange: setMode,
        context: cluster.context,
        contexts: cluster.contexts?.contexts ?? [],
        onContextChange: cluster.setContext,
        platformLabel: platformLabel(platform, info),
        namespace: info?.kubernetes?.namespace ?? null,
        watching: cluster.cluster.connected && !cluster.error,
      })}
      <main className="main">
        {missing && <p className="muted">That run is not in the selected time window.</p>}
        <InfraView
          cluster={cluster}
          mode={mode}
          selectedPod={selectedPod}
          onSelectPod={setSelectedPod}
          onOpenRun={(sha) => void openRun(sha)}
          onRetry={onRetry}
        />
      </main>
      <InfraFooter totals={model?.totals ?? null} />
    </>
  );
}
