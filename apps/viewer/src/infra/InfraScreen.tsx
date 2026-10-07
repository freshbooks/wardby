import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

const RUN_NOTE = "That run is not in the selected time window.";
const POD_NOTE = "No pod for this run — finished runs' pods are removed.";

interface Props {
  server: ServerSummary;
  runs: readonly GraphRun[];
  /** The top bar, given the Infrastructure controls it should show. */
  topBar: (infra: InfraBar) => ReactNode;
  /** Switch to the Runs tab with this run selected. */
  onOpenRun: (runId: string) => void;
  onRetry: () => void;
  /** A run whose pod should be selected (by run sha) as soon as the cluster data has it. */
  pendingRunSha: string | null;
  /** The pending request was resolved (or abandoned): clear it. */
  onPendingRunSha: () => void;
  /** Widen the Runs window to 7d; false when it already covers that much. */
  widenWindow: () => boolean;
}

/** The Infrastructure tab: owns the cluster watch, so it only runs while the tab is open. */
export function InfraScreen({
  server,
  runs,
  topBar,
  onOpenRun,
  onRetry,
  pendingRunSha,
  onPendingRunSha,
  widenWindow,
}: Props) {
  const cluster = useCluster(server);
  const [mode, setMode] = useState<InfraMode>("map");
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  // A note under the tab: that run is not loaded, or that run has no pod.
  const [note, setNote] = useState<string | null>(null);
  // Set after widening the window: the run to open once the wider load has arrived.
  const [waiting, setWaiting] = useState<{ sha: string; chars: number; base: readonly GraphRun[] } | null>(null);

  const { info } = cluster;
  const model = useMemo(
    () => (info?.kubernetes && !cluster.error ? describe(cluster.cluster, info) : null),
    [cluster.cluster, cluster.error, info],
  );
  const platform = info ? platformOf(info, cluster.cluster) : "generic";

  const findRun = useCallback(
    async (sha: string, chars: number) => {
      for (const r of runs) if ((await runSha(r.id, chars)) === sha) return r.id;
      return null;
    },
    [runs],
  );

  const openRun = useCallback(
    async (sha: string) => {
      const chars = info?.kubernetes?.runLabelHashChars ?? 40;
      const id = await findRun(sha, chars);
      if (id) {
        setNote(null);
        onOpenRun(id);
      } else if (widenWindow()) {
        setNote(null);
        setWaiting({ sha, chars, base: runs });
      } else {
        setNote(RUN_NOTE);
      }
    },
    [info, runs, findRun, onOpenRun, widenWindow],
  );

  // The wider load replaced the runs: open the run if it is there now, else keep the note.
  useEffect(() => {
    if (!waiting || runs === waiting.base) return;
    let active = true;
    void findRun(waiting.sha, waiting.chars).then((id) => {
      if (!active) return;
      setWaiting(null);
      if (id) onOpenRun(id);
      else setNote(RUN_NOTE);
    });
    return () => {
      active = false;
    };
  }, [waiting, runs, findRun, onOpenRun]);

  // Run -> pod: select the coding-run pod for the pending run once the pods have loaded.
  const runPods = model?.groups.codingRuns;
  const loadedPods = Boolean(model) && cluster.cluster.connected && model!.totals.pods > 0;
  const [handled, setHandled] = useState<string | null>(null);
  if (!pendingRunSha && handled) setHandled(null);
  if (pendingRunSha && pendingRunSha !== handled && runPods && loadedPods) {
    setHandled(pendingRunSha);
    const pod = runPods.find((p) => p.runSha && pendingRunSha.startsWith(p.runSha));
    if (pod) setSelectedPod(pod.name);
    setNote(pod ? null : POD_NOTE);
  }
  useEffect(() => {
    if (pendingRunSha && pendingRunSha === handled) onPendingRunSha();
  }, [pendingRunSha, handled, onPendingRunSha]);

  // Leaving the tab abandons an unresolved request.
  const clearPending = useRef(onPendingRunSha);
  useEffect(() => {
    clearPending.current = onPendingRunSha;
  });
  useEffect(() => () => clearPending.current(), []);

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
        {note && <p className="muted">{note}</p>}
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
