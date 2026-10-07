import type { InfraInfo } from "../api/types";
import { parseCpu, parseMemory, type Platform, type PodView } from "./adapter";

export function platformLabel(platform: Platform, info: InfraInfo | null): string {
  if (platform === "gke") return info?.kubernetes?.platform === "gke-autopilot" ? "GKE Autopilot" : "GKE";
  if (platform === "eks") return "EKS";
  if (platform === "kind") return "kind";
  return "Kubernetes";
}

/** Compact age: "45s", "12m", "3h", "2d". */
export function formatAge(startedAt: string | null, now: number = Date.now()): string {
  const t = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(t)) return "–";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export const formatCpu = (millis: number): string =>
  millis >= 1000 ? `${Number((millis / 1000).toFixed(2))}` : `${millis}m`;

export const formatMem = (mib: number): string =>
  mib >= 1024 ? `${Number((mib / 1024).toFixed(1))}Gi` : `${Math.round(mib)}Mi`;

/** "500m / 512Mi" for a pod's summed requests. */
export const podUsage = (p: PodView): string =>
  `${formatCpu(p.requests.cpuMillis)} / ${formatMem(p.requests.memoryMiB)}`;

/** One container's requests or limits, e.g. "500m / 512Mi"; unset values show a dash. */
export function resources(r: { cpu: string | null; memory: string | null }): string {
  const cpu = r.cpu ? formatCpu(parseCpu(r.cpu)) : "–";
  const mem = r.memory ? formatMem(parseMemory(r.memory)) : "–";
  return `${cpu} / ${mem}`;
}

export type DotKind = "ok" | "warn" | "bad" | "idle";
export function containerDot(c: { ready: boolean; state: string; reason: string | null }): DotKind {
  if (c.ready) return "ok";
  if (c.state === "terminated") return c.reason === "Completed" ? "idle" : "bad";
  if (c.state === "waiting") return c.reason && /Error|BackOff|Invalid/.test(c.reason) ? "bad" : "warn";
  return "warn";
}

export function statusKind(p: PodView): DotKind {
  if (p.status === "Succeeded") return "idle";
  if (p.ready || p.status === "Running") return p.ready ? "ok" : "warn";
  if (/Error|BackOff|Failed|Invalid|OOM/.test(p.status)) return "bad";
  return "warn";
}
