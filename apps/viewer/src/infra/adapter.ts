import type { InfraInfo } from "../api/types";
import type {
  ClusterKind,
  ClusterState,
  InfraContainer,
  InfraEdge,
  InfraPod,
  InfraSecretStore,
  InfraServiceAccount,
  KindItem,
} from "./types";

export type Platform = "gke" | "eks" | "generic";
export interface EdgeView {
  label: string;
  detail: string[];
  hosts: string[];
}
export interface PodView {
  name: string;
  group: "always_on" | "coding_run" | "job";
  title: string;
  status: string;
  ready: boolean;
  runtime: string | null;
  node: string | null;
  identity: string | null;
  containers: InfraContainer[];
  runSha: string | null;
  requests: { cpuMillis: number; memoryMiB: number };
  startedAt: string | null;
}
export interface DataStoreView {
  label: string;
  detail: string[];
}
export interface InfraModel {
  platform: Platform;
  edge: EdgeView[];
  groups: { alwaysOn: PodView[]; codingRuns: PodView[]; jobs: PodView[] };
  isolation: { egressRules: string[]; sandbox: string | null };
  dataStores: DataStoreView[];
  secrets: { source: string | null; names: string[] | null };
  totals: { pods: number; codingRuns: number; readyContainers: number; cpuMillis: number; memoryMiB: number };
}

/** Kubernetes CPU quantity ("500m", "2", "0.5") to millicores. */
export function parseCpu(q: string | null | undefined): number {
  if (!q) return 0;
  const m = /^([0-9.]+)(m?)$/.exec(q.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(m[2] ? n : n * 1000) : 0;
}

const MEM_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  "": 1,
};

/** Kubernetes memory quantity ("512Mi", "4Gi", "1G", bytes) to MiB. */
export function parseMemory(q: string | null | undefined): number {
  if (!q) return 0;
  const m = /^([0-9.]+)([KMGT]i?)?$/.exec(q.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? (n * MEM_UNITS[m[2] ?? ""]) / 1024 ** 2 : 0;
}

interface PlatformRules {
  edge(e: InfraEdge): EdgeView;
  identity(sa: InfraServiceAccount | null): string | null;
  database(alwaysOn: PodView[]): DataStoreView;
  secrets(stores: InfraSecretStore[]): string | null;
  sandbox(runtimeClass: string | null): string | null;
}

const GENERIC_EDGE_LABELS: Record<string, string> = {
  ingress: "Ingress",
  gateway: "Gateway",
  httproute: "HTTPRoute",
  http_route: "HTTPRoute",
  loadbalancer: "Load Balancer",
};

const genericEdge = (e: InfraEdge): EdgeView => ({
  label: GENERIC_EDGE_LABELS[e.kind] ?? e.kind,
  detail: [],
  hosts: e.hosts,
});

const genericDatabase = (): DataStoreView => ({ label: "Postgres (external)", detail: [] });

const gkeEdge = (e: InfraEdge): EdgeView => {
  if (e.kind !== "gateway") return genericEdge(e);
  const detail: string[] = [];
  const armor = Object.entries(e.annotations).some(
    ([k, v]) =>
      (k.startsWith("networking.gke.io/") || k.startsWith("cloud.google.com/")) &&
      /armor|security[-_ ]?policy/i.test(`${k} ${v}`),
  );
  if (armor) detail.push("Cloud Armor");
  if (e.hosts.length) detail.push("TLS");
  return { label: "Gateway", detail, hosts: e.hosts };
};

const gkeIdentity = (sa: InfraServiceAccount | null): string | null => {
  if (!sa) return null;
  const gsa = sa.identity["iam.gke.io/gcp-service-account"];
  return gsa ? `GSA ${gsa}` : `SA ${sa.name}`;
};

const gkeDatabase = (alwaysOn: PodView[]): DataStoreView =>
  alwaysOn.some((p) => p.containers.some((c) => c.image.includes("cloud-sql-proxy")))
    ? { label: "Cloud SQL", detail: ["via Auth Proxy", "IAM login"] }
    : genericDatabase();

const RULES: Record<Platform, PlatformRules> = {
  generic: {
    edge: genericEdge,
    identity: (sa) => (sa ? `SA ${sa.name}` : null),
    database: genericDatabase,
    secrets: (stores) => (stores.length ? "External Secrets" : null),
    sandbox: (rc) => rc,
  },
  gke: {
    edge: gkeEdge,
    identity: gkeIdentity,
    database: gkeDatabase,
    secrets: (stores) =>
      stores.some((s) => s.provider === "gcpsm") ? "Secret Manager" : stores.length ? "External Secrets" : null,
    sandbox: (rc) => rc,
  },
  // PR 3 adds EKS; platformOf never returns it until then.
  eks: undefined as never,
};

export function platformOf(info: InfraInfo, cluster: ClusterState): Platform {
  // The server reports "generic" or "gke-autopilot"; other GKE (Standard) is detected only via the SA fallback below.
  if (info.kubernetes?.platform.startsWith("gke")) return "gke";
  for (const sa of cluster.objects.service_account.values()) {
    if ("iam.gke.io/gcp-service-account" in sa.identity) return "gke";
  }
  return "generic";
}

const ALWAYS_ON: [prefix: string, title: string][] = [
  ["wardby-control-plane", "control-plane"],
  ["wardby-coding-proxy", "coding-proxy"],
  ["wardby-headroom", "headroom"],
];

const values = <K extends ClusterKind>(c: ClusterState, k: K): KindItem<K>[] => [...c.objects[k].values()];

function runtimeName(rc: string | null): string | null {
  if (!rc) return null;
  const l = rc.toLowerCase();
  if (l.includes("gvisor") || l === "runsc") return "gVisor";
  if (l.includes("kata")) return "Kata";
  return rc;
}

function podStatus(p: InfraPod): string {
  const bad = p.containers.find((c) => !c.ready && c.reason && c.state !== "terminated");
  return bad?.reason ?? p.phase;
}

function matches(selector: Record<string, string | undefined>, labels: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => labels[k] === v);
}

export function describe(cluster: ClusterState, info: InfraInfo): InfraModel {
  const platform = platformOf(info, cluster);
  const rules = RULES[platform];
  const k8s = info.kubernetes;
  const componentLabel = k8s?.componentLabel ?? {};
  const sas = cluster.objects.service_account;

  const view = (p: InfraPod, group: PodView["group"], title: string): PodView => {
    const sa = p.serviceAccount ? (sas.get(p.serviceAccount) ?? { name: p.serviceAccount, identity: {} }) : null;
    const main = p.containers.filter((c) => c.role !== "init");
    return {
      name: p.name,
      group,
      title,
      status: podStatus(p),
      ready: p.ready,
      runtime: runtimeName(p.runtimeClass),
      node: p.node,
      identity: rules.identity(sa),
      containers: p.containers,
      runSha: group === "coding_run" && k8s ? (p.labels[k8s.runLabel] ?? null) : null,
      requests: {
        cpuMillis: main.reduce((s, c) => s + parseCpu(c.requests.cpu), 0),
        memoryMiB: Math.round(main.reduce((s, c) => s + parseMemory(c.requests.memory), 0)),
      },
      startedAt: p.startedAt,
    };
  };

  const alwaysOn: PodView[] = [];
  const codingRuns: PodView[] = [];
  const jobs: PodView[] = [];
  for (const p of values(cluster, "pod")) {
    if (matches(componentLabel, p.labels)) {
      codingRuns.push(view(p, "coding_run", p.name));
      continue;
    }
    const ownerName = p.owner?.name ?? p.name;
    const hit = ALWAYS_ON.find(([prefix]) => ownerName === prefix || ownerName.startsWith(`${prefix}-`));
    if (hit) alwaysOn.push(view(p, "always_on", hit[1]));
    else if (p.owner?.kind === "Job") jobs.push(view(p, "job", p.owner.name));
  }
  const order = (p: PodView) => ALWAYS_ON.findIndex(([, t]) => t === p.title);
  alwaysOn.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  codingRuns.sort((a, b) => a.name.localeCompare(b.name));
  jobs.sort((a, b) => a.name.localeCompare(b.name));

  const edges: InfraEdge[] = [
    ...values(cluster, "ingress"),
    ...values(cluster, "gateway"),
    ...values(cluster, "http_route"),
    ...values(cluster, "service").flatMap((s) => (s.edge ? [s.edge] : [])),
  ];

  const egressRules = values(cluster, "network_policy")
    .filter((np) => matches(componentLabel, np.podSelector as Record<string, string>))
    .flatMap((np) => np.egress);

  const stores = values(cluster, "secret_store");
  const forbidden = cluster.kindErrors.secret !== undefined; // any error: names unknown
  const all = [...alwaysOn, ...codingRuns, ...jobs];

  return {
    platform,
    edge: edges.map(rules.edge),
    groups: { alwaysOn, codingRuns, jobs },
    isolation: { egressRules, sandbox: rules.sandbox(runtimeName(k8s?.runtimeClass ?? null)) },
    dataStores: [rules.database(alwaysOn)],
    secrets: {
      source: rules.secrets(stores),
      names: forbidden ? null : values(cluster, "secret").map((s) => s.name),
    },
    totals: {
      pods: all.length,
      codingRuns: codingRuns.length,
      readyContainers: all.reduce((s, p) => s + p.containers.filter((c) => c.ready).length, 0),
      cpuMillis: all.reduce((s, p) => s + p.requests.cpuMillis, 0),
      memoryMiB: all.reduce((s, p) => s + p.requests.memoryMiB, 0),
    },
  };
}
