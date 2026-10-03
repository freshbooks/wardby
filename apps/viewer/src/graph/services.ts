import type { GraphRun, ServiceState } from "../api/types";

export interface TrayService {
  name: string;
  /** "postgres 16", or just the name when no version was declared. */
  label: string;
  /** "unrecorded": a finished run that never reported this service's state. */
  state: ServiceState | "unrecorded";
  /** Probe attempts so far, when probing. */
  attempts: number | null;
  /** Hover text: the full state, including a failure reason. */
  title: string;
}

const STATE_TEXT: Record<TrayService["state"], string> = {
  ready: "ready",
  probing: "probing",
  pending: "pending",
  failed: "failed",
  unrecorded: "status not recorded",
};

/**
 * One entry per service: the declared services first, in their declared order, then any
 * with a recorded state that was not declared. A recorded state wins; a live run's
 * unreported service is pending, and a finished run's is unrecorded.
 */
export function trayServices(run: GraphRun): TrayService[] {
  const live = run.status === "pending" || run.status === "running";
  const statuses = new Map(run.services.map((s) => [s.name, s]));
  const versions = new Map((run.declaredServices ?? []).map((d) => [d.name, d.version]));
  const names = [...new Set([...versions.keys(), ...statuses.keys()])];
  return names.map((name) => {
    const status = statuses.get(name);
    const version = versions.get(name);
    const label = version ? `${name} ${version}` : name;
    const state = status?.state ?? (live ? "pending" : "unrecorded");
    const attempts = status?.state === "probing" ? status.attempts : null;
    const detail = [
      STATE_TEXT[state],
      attempts !== null ? `attempt ${attempts}` : "",
      status?.state === "failed" && status.reason ? status.reason : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return { name, label, state, attempts, title: `${label}: ${detail}` };
  });
}
