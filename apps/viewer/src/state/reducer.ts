import type { GraphRun, GraphSnapshot, ServiceStatus, ViewerEvent } from "../api/types";

export interface TickerItem {
  at: number;
  text: string;
}

export interface ViewerModel {
  runs: Map<string, GraphRun>;
  spend: GraphSnapshot["spend"] | null;
  truncated: boolean;
  /** From SSE status frames. */
  live: boolean;
  /** An event referenced something the snapshot lacks. */
  needsRefetch: boolean;
  /** Newest first, max TICKER_MAX. */
  ticker: TickerItem[];
}

export type Action =
  | { type: "snapshot"; snapshot: GraphSnapshot }
  | { type: "event"; event: ViewerEvent; at: number; agentName?: (agentId: string) => string | undefined }
  | { type: "status"; connected: boolean }
  | { type: "reset" };

const TICKER_MAX = 50;

export const initialModel: ViewerModel = {
  runs: new Map(),
  spend: null,
  truncated: false,
  live: false,
  needsRefetch: false,
  ticker: [],
};

const short = (id: string): string => id.slice(-6);

function tickerText(event: ViewerEvent, agentName?: (agentId: string) => string | undefined): string {
  switch (event.kind) {
    case "run": {
      const name = agentName?.(event.agentId);
      const line = `${short(event.runId)} ${event.status} · turn ${event.turns} · $${event.costUsd.toFixed(2)}`;
      return name ? `${name} ${line}` : line;
    }
    case "service":
      return `${short(event.runId)} ${event.name} ${event.state}`;
    case "outcome":
      return `${short(event.runId)} ${event.source.replace("_", " ")}`;
  }
}

function upsertService(
  services: readonly ServiceStatus[],
  event: Extract<ViewerEvent, { kind: "service" }>,
  at: number,
) {
  const index = services.findIndex((s) => s.name === event.name);
  if (index === -1) {
    const added: ServiceStatus = {
      name: event.name,
      state: event.state,
      attempts: event.attempts,
      reason: null,
      readyAt: null,
      failedAt: null,
      createdAt: new Date(at).toISOString(),
    };
    return [...services, added];
  }
  return services.map((s, i) => (i === index ? { ...s, state: event.state, attempts: event.attempts } : s));
}

function applyEvent(model: ViewerModel, event: ViewerEvent, at: number): Pick<ViewerModel, "runs" | "needsRefetch"> {
  if (event.kind === "outcome") return { runs: model.runs, needsRefetch: true };
  const run = model.runs.get(event.runId);
  if (!run) return { runs: model.runs, needsRefetch: true };
  const updated: GraphRun =
    event.kind === "run"
      ? {
          ...run,
          status: event.status,
          turns: event.turns,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          costUsd: event.costUsd,
          finishedAt: event.finishedAt,
          parentRunId: event.parentRunId,
        }
      : { ...run, services: upsertService(run.services, event, at) };
  const runs = new Map(model.runs);
  runs.set(run.id, updated);
  return { runs, needsRefetch: model.needsRefetch };
}

export function reduce(model: ViewerModel, action: Action): ViewerModel {
  switch (action.type) {
    case "snapshot":
      return {
        ...model,
        runs: new Map(action.snapshot.runs.map((r) => [r.id, r])),
        spend: action.snapshot.spend,
        truncated: action.snapshot.truncated,
        needsRefetch: false,
      };
    case "event": {
      const applied = applyEvent(model, action.event, action.at);
      const item: TickerItem = { at: action.at, text: tickerText(action.event, action.agentName) };
      return { ...model, ...applied, ticker: [item, ...model.ticker].slice(0, TICKER_MAX) };
    }
    case "status":
      return { ...model, live: action.connected };
    case "reset":
      return initialModel;
  }
}
