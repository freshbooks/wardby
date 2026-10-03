import { useCallback, useEffect, useMemo, useState } from "react";
import { isAppError, listServers, removeServer, signOut, type AppError, type ServerSummary } from "./api/client";
import { BottomBar } from "./chrome/BottomBar";
import { ConfirmDialog } from "./chrome/ConfirmDialog";
import { ErrorBoundary } from "./chrome/ErrorBoundary";
import { ErrorLine } from "./chrome/ErrorLine";
import { ServerDialog } from "./chrome/ServerDialog";
import { ServerMenu } from "./chrome/ServerMenu";
import { SignInGate } from "./chrome/SignInGate";
import { TopBar, windowSpend } from "./chrome/TopBar";
import { FlowCanvas } from "./graph/FlowCanvas";
import { DetailPanel } from "./panel/DetailPanel";
import { Timeline } from "./timeline/Timeline";
import { changeFilters, initialFilters, visibleRuns, type Filters } from "./state/filters";
import { useViewer } from "./state/useViewer";

const GRAPH_LIMIT = 500;

interface DashboardProps {
  server: ServerSummary;
  servers: ServerSummary[];
  onSelectServer: (url: string) => void;
  onAddServer: () => void;
  onSignOut: () => void;
  onRemoveServer: () => void;
  onChecked: (servers: ServerSummary[] | null, ok: boolean) => void;
}

function Dashboard({
  server,
  servers,
  onSelectServer,
  onAddServer,
  onSignOut,
  onRemoveServer,
  onChecked,
}: DashboardProps) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  // The canvas highlights this run and the detail panel shows it.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const viewer = useViewer(server.url, { since: filters.window, limit: GRAPH_LIMIT });
  const { model } = viewer;
  const selectedRun = selectedRunId ? model.runs.get(selectedRunId) : undefined;

  const onSelect = useCallback(
    (id: string | null) => setSelectedRunId((cur) => (id === null || id === cur ? null : id)),
    [],
  );
  // The panel navigates to a run (children/parent) or closes; unlike the canvas it never toggles.
  const selectPanel = useCallback((id: string | null) => setSelectedRunId(id), []);

  const runs = useMemo(() => [...model.runs.values()], [model.runs]);
  const agents = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of runs) byId.set(r.agentId, r.agentName);
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [runs]);
  // Selected agents that left the window can't be cleared from the menu: ignore them.
  const view = useMemo<Filters>(() => {
    const ids = new Set(agents.map((a) => a.id));
    return { ...filters, agents: new Set([...filters.agents].filter((id) => ids.has(id))) };
  }, [filters, agents]);

  const shown = useMemo(() => visibleRuns(runs, view), [runs, view]);
  const setRange = useCallback((timeRange: Filters["timeRange"]) => setFilters((f) => ({ ...f, timeRange })), []);

  return (
    <div className="app">
      <TopBar
        servers={servers}
        selectedUrl={server.url}
        onSelectServer={onSelectServer}
        onAddServer={onAddServer}
        onSignOut={onSignOut}
        onRemoveServer={onRemoveServer}
        live={model.live}
        reconnecting={viewer.reconnecting}
        filters={view}
        onFiltersChange={(next) => setFilters((prev) => changeFilters(prev, next))}
        agents={agents}
        spend={model.spend}
        windowSpendUsd={windowSpend(runs)}
      />
      <main className="main">
        {viewer.needsSignIn ? (
          <SignInGate
            server={server}
            onChecked={onChecked}
            message="Your session ended. Sign in again to resume the live view."
          />
        ) : (
          <>
            {viewer.forbidden && (
              <p role="alert" className="error">
                This account needs the admin role (admin:view) to use the viewer.
              </p>
            )}
            {viewer.error && !viewer.forbidden && (
              <>
                <ErrorLine error={viewer.error} />
                <button type="button" onClick={viewer.retry}>
                  Retry
                </button>
              </>
            )}
            {!viewer.loaded && !viewer.error && <p className="muted">Loading…</p>}
            {viewer.loaded && (
              <Timeline
                runs={runs}
                window={filters.window}
                timeRange={filters.timeRange}
                onRangeChange={setRange}
                onSelect={onSelect}
                selectedId={selectedRunId}
              />
            )}
            {viewer.loaded && model.truncated && (
              <p className="muted">Showing the most recent {GRAPH_LIMIT} runs; narrow the window to see fewer.</p>
            )}
            {viewer.loaded && (
              <div className="workspace">
                <FlowCanvas runs={runs} filters={view} selectedId={selectedRunId} onSelect={onSelect} />
                {selectedRun && (
                  <DetailPanel serverUrl={server.url} run={selectedRun} runs={model.runs} onSelect={selectPanel} />
                )}
              </div>
            )}
          </>
        )}
      </main>
      <BottomBar runs={shown} ticker={model.ticker} window={filters.window} />
    </div>
  );
}

function toAppError(e: unknown): AppError {
  return isAppError(e) ? e : { kind: "protocol", message: e instanceof Error ? e.message : String(e) };
}

export function App() {
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // A server whose removal awaits confirmation.
  const [removing, setRemoving] = useState<ServerSummary | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped to restart the data flow (new connect) after a successful sign-in.
  const [epoch, setEpoch] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setServers(await listServers());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setServers((s) => s ?? []);
    }
  }, []);

  useEffect(() => {
    let active = true;
    listServers().then(
      (list) => active && setServers(list),
      (e: unknown) => {
        if (!active) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setServers([]);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (servers === null) return <p className="muted center">Loading…</p>;

  const selected = servers.find((s) => s.url === selectedUrl) ?? servers[0] ?? null;

  const onChecked = (list: ServerSummary[] | null, ok: boolean) => {
    if (list) {
      const was = selected?.signed_in ?? false;
      const now = list.find((s) => s.url === selected?.url)?.signed_in ?? false;
      setServers(list);
      if (ok || (now && !was)) setEpoch((n) => n + 1);
    } else if (ok) {
      void refresh();
      setEpoch((n) => n + 1);
    }
  };

  // Signing out forgets this device's grant (Keychain entry and in-memory token);
  // it is not revoked at the server.
  const doSignOut = async (url: string) => {
    setActionError(null);
    try {
      await signOut(url);
    } catch (e) {
      setActionError(toAppError(e));
    }
    await refresh();
  };

  const doRemove = async (server: ServerSummary) => {
    setRemoving(null);
    setActionError(null);
    try {
      await removeServer(server.url);
    } catch (e) {
      setActionError(toAppError(e));
    }
    if (selectedUrl === server.url) setSelectedUrl(null);
    await refresh();
  };

  if (!selected) {
    return (
      <>
        {loadError && <ErrorLine error={{ kind: "storage", message: loadError }} />}
        {actionError && <ErrorLine error={actionError} />}
        <ServerDialog
          onAdded={async () => {
            const list = await listServers().catch(() => null);
            if (list) {
              setServers(list);
              setSelectedUrl(list[0]?.url ?? null);
            }
          }}
        />
      </>
    );
  }

  // The dashboard (and so its event stream) stays mounted under the dialogs.
  const overlays = (
    <>
      {adding && (
        <ServerDialog
          onAdded={async () => {
            const list = await listServers().catch(() => null);
            if (list) {
              const added = list.find((s) => !servers.some((o) => o.url === s.url));
              setServers(list);
              if (added) setSelectedUrl(added.url);
            }
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message="This signs you out on this device and removes the server from the list. Nothing changes on the server."
          confirmLabel="Remove server"
          onConfirm={() => void doRemove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );

  if (!selected.signed_in) {
    return (
      <>
        <div className="app">
          <header className="topbar">
            <div className="topbar-row">
              <span className="brand">wardby</span>
              <label className="inline">
                <span className="sr-only">Server</span>
                <select
                  aria-label="Server"
                  value={selected.url}
                  onChange={(e) => (e.target.value === "__add" ? setAdding(true) : setSelectedUrl(e.target.value))}
                >
                  {servers.map((s) => (
                    <option key={s.url} value={s.url}>
                      {s.name}
                    </option>
                  ))}
                  <option value="__add">Add server…</option>
                </select>
              </label>
              <ServerMenu signedIn={false} onSignOut={() => undefined} onRemove={() => setRemoving(selected)} />
            </div>
          </header>
          <main className="main">
            {actionError && <ErrorLine error={actionError} />}
            <SignInGate key={selected.url} server={selected} onChecked={onChecked} />
          </main>
        </div>
        {overlays}
      </>
    );
  }

  return (
    <>
      <ErrorBoundary key={`${selected.url}#${epoch}`}>
        <Dashboard
          server={selected}
          servers={servers}
          onSelectServer={setSelectedUrl}
          onAddServer={() => setAdding(true)}
          onSignOut={() => void doSignOut(selected.url)}
          onRemoveServer={() => setRemoving(selected)}
          onChecked={onChecked}
        />
      </ErrorBoundary>
      {actionError && (
        <div className="toast">
          <ErrorLine error={actionError} />
        </div>
      )}
      {overlays}
    </>
  );
}
