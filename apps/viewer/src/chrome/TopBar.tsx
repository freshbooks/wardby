import type { ServerSummary } from "../api/client";
import type { ViewerModel } from "../state/reducer";
import { ServerMenu } from "./ServerMenu";
import { STATUS_GROUPS, WINDOWS, type Filters, type StatusGroup, type WindowSize } from "../state/filters";

const GROUP_LABEL: Record<StatusGroup, string> = {
  running: "running",
  failed: "failed",
  succeeded: "succeeded",
  pending: "pending",
};

interface Props {
  servers: ServerSummary[];
  selectedUrl: string | null;
  onSelectServer: (url: string) => void;
  onAddServer: () => void;
  onSignOut: () => void;
  onRemoveServer: () => void;
  live: boolean;
  reconnecting: boolean;
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  agents: { id: string; name: string }[];
  spend: ViewerModel["spend"];
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** Today's spend against the smallest daily group cap, when any group has one. */
export function spendSummary(spend: ViewerModel["spend"]): { spent: number; cap: number | null } | null {
  if (!spend) return null;
  const caps = spend.groups.map((g) => g.dailyBudgetUsd).filter((c): c is number => c !== null && c > 0);
  return { spent: spend.todayUsd, cap: caps.length > 0 ? Math.min(...caps) : null };
}

export function TopBar(props: Props) {
  const { servers, selectedUrl, filters, onFiltersChange } = props;
  const spend = spendSummary(props.spend);
  const set = (patch: Partial<Filters>) => onFiltersChange({ ...filters, ...patch });
  const badge = props.live ? "● live" : props.reconnecting ? "◌ reconnecting" : "○ offline";

  return (
    <header className="topbar">
      <div className="topbar-row">
        <span className="brand">wardby</span>
        <label className="inline">
          <span className="sr-only">Server</span>
          <select
            aria-label="Server"
            value={selectedUrl ?? ""}
            onChange={(e) => {
              if (e.target.value === "__add") props.onAddServer();
              else props.onSelectServer(e.target.value);
            }}
          >
            {servers.map((s) => (
              <option key={s.url} value={s.url}>
                {s.name}
              </option>
            ))}
            <option value="__add">Add server…</option>
          </select>
        </label>
        <ServerMenu signedIn onSignOut={props.onSignOut} onRemove={props.onRemoveServer} />
        <span
          className={`badge ${props.live ? "live" : props.reconnecting ? "reconnecting" : "offline"}`}
          role="status"
        >
          {badge}
        </span>
      </div>
      <div className="topbar-row">
        <label className="inline">
          <span className="sr-only">Time window</span>
          <select
            aria-label="Time window"
            value={filters.window}
            onChange={(e) => set({ window: e.target.value as WindowSize })}
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                Last {w}
              </option>
            ))}
          </select>
        </label>
        <details className="agent-filter">
          <summary>{filters.agents.size === 0 ? "Agents: all" : `Agents: ${filters.agents.size}`}</summary>
          <div className="popover">
            {props.agents.length === 0 && <span className="muted">No agents in window</span>}
            {props.agents.map((a) => (
              <label key={a.id} className="check">
                <input
                  type="checkbox"
                  checked={filters.agents.has(a.id)}
                  onChange={() => set({ agents: toggled(filters.agents, a.id) })}
                />
                {a.name}
              </label>
            ))}
          </div>
        </details>
        <fieldset className="statuses">
          <legend className="sr-only">Status</legend>
          {STATUS_GROUPS.map((g) => (
            <label key={g} className="check">
              <input
                type="checkbox"
                checked={filters.statuses.has(g)}
                onChange={() => set({ statuses: toggled(filters.statuses, g) })}
              />
              {GROUP_LABEL[g]}
            </label>
          ))}
        </fieldset>
        <input
          type="search"
          aria-label="Search runs"
          placeholder="search…"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
        />
        {spend && (
          <div className="spend" aria-label="Today's spend">
            <span>
              Today ${spend.spent.toFixed(2)}
              {spend.cap !== null && ` / $${spend.cap.toFixed(2)}`}
            </span>
            {spend.cap !== null && (
              <div
                className="meter"
                role="meter"
                aria-label="Spend against daily cap"
                aria-valuemin={0}
                aria-valuemax={spend.cap}
                aria-valuenow={Math.min(spend.spent, spend.cap)}
              >
                <div style={{ width: `${Math.min(100, (spend.spent / spend.cap) * 100)}%` }} />
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
