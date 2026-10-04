/**
 * Whether one more coding-run pod fits a namespace ResourceQuota (KUBERNETES_RESOURCE_QUOTA).
 * The launcher asks before a run claims a slot, so a run that would be refused at pod create
 * ("exceeded quota") waits in the coding queue instead of failing.
 */
import type { V1Container, V1Pod, V1ResourceQuota } from "@kubernetes/client-node";

/** What a pod adds to a quota: millicores, bytes, and one pod. */
export interface PodQuotaUsage {
  "requests.cpu": number;
  "limits.cpu": number;
  "requests.memory": number;
  "limits.memory": number;
  pods: number;
}

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50 };
const DECIMAL: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
const QUANTITY = /^([0-9]+(?:\.[0-9]+)?)(m|Ki|Mi|Gi|Ti|Pi|k|M|G|T|P)?$/;

/** A Kubernetes CPU quantity ("250m", "1.5", "8") in millicores, or null when unparseable. */
export function cpuMillicores(quantity: string | number | undefined): number | null {
  if (quantity === undefined) return 0;
  const match = QUANTITY.exec(String(quantity).trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (match[2] === "m") return value;
  if (match[2] !== undefined) return null;
  return value * 1000;
}

/** A Kubernetes memory quantity ("512Mi", "1G", "1048576") in bytes, or null when unparseable. */
export function memoryBytes(quantity: string | number | undefined): number | null {
  if (quantity === undefined) return 0;
  const match = QUANTITY.exec(String(quantity).trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === undefined) return value;
  if (unit === "m") return value / 1000;
  return value * (BINARY[unit] ?? DECIMAL[unit] ?? NaN);
}

function sum(containers: readonly V1Container[]): PodQuotaUsage {
  const total: PodQuotaUsage = {
    "requests.cpu": 0,
    "limits.cpu": 0,
    "requests.memory": 0,
    "limits.memory": 0,
    pods: 1,
  };
  for (const container of containers) {
    const requests = container.resources?.requests ?? {};
    const limits = container.resources?.limits ?? {};
    total["requests.cpu"] += cpuMillicores(requests.cpu) ?? 0;
    total["limits.cpu"] += cpuMillicores(limits.cpu) ?? 0;
    total["requests.memory"] += memoryBytes(requests.memory) ?? 0;
    total["limits.memory"] += memoryBytes(limits.memory) ?? 0;
  }
  return total;
}

/**
 * The pod's effective requests and limits, as quota admission counts them: its containers plus
 * native sidecars (init containers with restartPolicy Always), or its largest ordinary init
 * container if that is bigger. Close enough for an admission pre-check; the API server stays the
 * authority.
 */
export function podQuotaUsage(pod: V1Pod): PodQuotaUsage {
  const init = pod.spec?.initContainers ?? [];
  const sidecars = init.filter((container) => container.restartPolicy === "Always");
  const running = sum([...(pod.spec?.containers ?? []), ...sidecars]);
  for (const container of init.filter((c) => c.restartPolicy !== "Always")) {
    const one = sum([container]);
    for (const key of ["requests.cpu", "limits.cpu", "requests.memory", "limits.memory"] as const) {
      running[key] = Math.max(running[key], one[key]);
    }
  }
  return running;
}

/** Quota keys and the aliases Kubernetes accepts for them ("cpu" means "requests.cpu"). */
const KEYS: ReadonlyArray<readonly [keyof PodQuotaUsage, readonly string[], "cpu" | "memory" | "count"]> = [
  ["requests.cpu", ["requests.cpu", "cpu"], "cpu"],
  ["limits.cpu", ["limits.cpu"], "cpu"],
  ["requests.memory", ["requests.memory", "memory"], "memory"],
  ["limits.memory", ["limits.memory"], "memory"],
  ["pods", ["pods", "count/pods"], "count"],
];

function parse(kind: "cpu" | "memory" | "count", value: string | undefined): number | null {
  if (kind === "cpu") return cpuMillicores(value);
  if (kind === "memory") return memoryBytes(value);
  if (value === undefined) return 0;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

/**
 * The first quota resource the pod would exceed (for example "requests.cpu"), or null when it
 * fits. A quota with no status yet, or a value this can't parse, never blocks: the API server
 * still has the final word at create.
 */
export function quotaShortfall(quota: V1ResourceQuota, usage: PodQuotaUsage): string | null {
  const hard = quota.status?.hard;
  if (!hard) return null;
  const used = quota.status?.used ?? {};
  for (const [field, names, kind] of KEYS) {
    for (const name of names) {
      if (hard[name] === undefined) continue;
      const limit = parse(kind, hard[name]);
      const current = parse(kind, used[name]);
      if (limit === null || current === null) continue;
      if (current + usage[field] > limit) return name;
    }
  }
  return null;
}
