import type { InfraInfo } from "../api/types";
import type {
  ClusterKind,
  ClusterState,
  InfraBackendPolicy,
  InfraContainer,
  InfraEdge,
  InfraNetworkPolicy,
  InfraPod,
  InfraSecretStore,
  InfraServiceAccount,
  KindItem,
} from "./types";

/** Like kubectl's READY: one-shot init containers are setup steps, not part of the count. */
export function countsTowardReady(c: { role: string }): boolean {
  return c.role !== "init";
}

export type Platform = "gke" | "eks" | "kind" | "generic";

export interface DescribeOpts {
  serverUrl?: string;
  context?: string | null;
}
export interface EdgeView {
  label: string;
  detail: string[];
  hosts: string[];
}
export interface PodView {
  name: string;
  group: "always_on" | "coding_run" | "job";
  title: string;
  /** What to show for the pod: Terminating, Completed, a container problem, or its phase. */
  status: string;
  phase: string;
  terminating: boolean;
  ready: boolean;
  /** Runtime class label; for a coding run without a sandbox, "none (container runtime)". */
  runtime: string | null;
  /** The pod runs in a sandbox runtime class (gVisor, Kata, ...). */
  sandboxed: boolean;
  node: string | null;
  identity: string | null;
  containers: InfraContainer[];
  runSha: string | null;
  /** Egress rules of the NetworkPolicies that select this pod. */
  egress: string[];
  /** Names of the NetworkPolicies that select this pod. */
  policies: string[];
  requests: { cpuMillis: number; memoryMiB: number };
  startedAt: string | null;
}
export interface DataStoreView {
  label: string;
  detail: string[];
}
export interface InfraModel {
  platform: Platform;
  controlPlane: { inCluster: true } | { inCluster: false; location: string | null };
  edge: EdgeView[];
  groups: { alwaysOn: PodView[]; codingRuns: PodView[]; jobs: PodView[] };
  isolation: {
    egressRules: string[];
    sandbox: string | null;
    /** Every NetworkPolicy in the namespace; `defaultDeny` when one selects all pods and allows nothing. */
    policies: { count: number; defaultDeny: boolean };
  };
  dataStores: DataStoreView[];
  /** `names` is null when they can't be read; `forbidden` says that is for lack of access. */
  secrets: { source: string | null; names: string[] | null; forbidden: boolean };
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

interface EdgeContext {
  backendPolicies: InfraBackendPolicy[];
}

interface PlatformRules {
  edge(e: InfraEdge, ctx: EdgeContext): EdgeView;
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

const isRoute = (e: InfraEdge) => e.kind === "httproute" || e.kind === "http_route";

/** A route's detail: its hostnames, or what a redirect-only route does. */
function routeDetail(e: InfraEdge): string[] {
  if (e.redirectOnly) return [e.redirectScheme === "https" ? "HTTP → HTTPS redirect" : "Redirect"];
  return e.hosts.length ? [e.hosts.join(", ")] : [];
}

const genericEdge = (e: InfraEdge): EdgeView => ({
  label: GENERIC_EDGE_LABELS[e.kind] ?? e.kind,
  detail: isRoute(e) ? routeDetail(e) : [],
  hosts: e.hosts,
});

/** Cloud Armor policy names a GCPBackendPolicy attaches to a Gateway or to the Services a route sends traffic to. */
function armorPolicies(e: InfraEdge, ctx: EdgeContext): string[] {
  const names = ctx.backendPolicies.flatMap((p) => {
    if (!p.securityPolicy || !p.targetName) return [];
    if (e.kind === "gateway" && p.targetKind === "Gateway" && p.targetName === e.name) return [p.securityPolicy];
    if (isRoute(e) && p.targetKind === "Service" && e.backends.includes(p.targetName)) return [p.securityPolicy];
    return [];
  });
  return [...new Set(names)];
}

const genericDatabase = (): DataStoreView => ({ label: "Postgres (external)", detail: [] });

const gkeEdge = (e: InfraEdge, ctx: EdgeContext): EdgeView => {
  if (e.kind !== "gateway") {
    const view = genericEdge(e);
    return { ...view, detail: [...view.detail, ...armorPolicies(e, ctx).map((n) => `Cloud Armor ${n}`)] };
  }
  const detail: string[] = [];
  const armor = Object.entries(e.annotations).some(
    ([k, v]) =>
      (k.startsWith("networking.gke.io/") || k.startsWith("cloud.google.com/")) &&
      /armor|security[-_ ]?policy/i.test(`${k} ${v}`),
  );
  const named = armorPolicies(e, ctx);
  if (named.length) detail.push(...named.map((n) => `Cloud Armor ${n}`));
  else if (armor) detail.push("Cloud Armor");
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

const GENERIC_RULES: PlatformRules = {
  edge: genericEdge,
  identity: (sa) => (sa ? `SA ${sa.name}` : null),
  database: genericDatabase,
  secrets: (stores) => (stores.length ? "External Secrets" : null),
  sandbox: (rc) => rc,
};

const RULES: Record<Platform, PlatformRules> = {
  generic: GENERIC_RULES,
  gke: {
    edge: gkeEdge,
    identity: gkeIdentity,
    database: gkeDatabase,
    secrets: (stores) =>
      stores.some((s) => s.provider === "gcpsm") ? "Secret Manager" : stores.length ? "External Secrets" : null,
    sandbox: (rc) => rc,
  },
  kind: { ...GENERIC_RULES, sandbox: (rc) => rc ?? "none (container runtime)" },
  // PR 3 adds EKS; platformOf never returns it until then.
  eks: undefined as never,
};

const KIND_NODE = /^(.+)-(control-plane|worker\d*)$/;

/** kind names every node `<cluster>-control-plane` / `<cluster>-worker[N]`, all with one cluster prefix. */
function looksLikeKindNodes(cluster: ClusterState): boolean {
  const nodes = new Set<string>();
  for (const p of cluster.objects.pod.values()) if (p.node) nodes.add(p.node);
  const prefixes = new Set<string>();
  let control = false;
  for (const n of nodes) {
    const m = KIND_NODE.exec(n);
    if (!m) return false;
    prefixes.add(m[1]);
    if (m[2] === "control-plane") control = true;
  }
  return control && prefixes.size === 1;
}

export function platformOf(info: InfraInfo, cluster: ClusterState, opts: DescribeOpts = {}): Platform {
  // The server reports "generic" or "gke-autopilot"; other GKE (Standard) is detected only via the SA fallback below.
  if (info.kubernetes?.platform.startsWith("gke")) return "gke";
  for (const sa of cluster.objects.service_account.values()) {
    if ("iam.gke.io/gcp-service-account" in sa.identity) return "gke";
  }
  if (info.kubernetes?.platform !== "generic") return "generic";
  if (opts.context?.startsWith("kind-")) return "kind";
  return looksLikeKindNodes(cluster) ? "kind" : "generic";
}

function hostPort(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
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
  if (p.terminating) return "Terminating";
  if (p.phase === "Succeeded") return "Completed";
  const bad = p.containers.find((c) => !c.ready && c.reason && c.state !== "terminated");
  return bad?.reason ?? p.phase;
}

function matches(selector: Record<string, string | undefined>, labels: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => labels[k] === v);
}

const selects = (np: InfraNetworkPolicy, labels: Record<string, string>) =>
  np.selectsAll || matches(np.podSelector, labels);

/** An empty-selector policy that allows nothing for each direction it declares. */
function deniesAll(np: InfraNetworkPolicy): boolean {
  if (!np.selectsAll) return false;
  const types = np.policyTypes.length ? np.policyTypes : ["Ingress", ...(np.egress.length ? ["Egress"] : [])];
  return types.every((t) => (t === "Ingress" ? np.ingressRules === 0 : t === "Egress" ? np.egress.length === 0 : true));
}

export function describe(cluster: ClusterState, info: InfraInfo, opts: DescribeOpts = {}): InfraModel {
  const platform = platformOf(info, cluster, opts);
  const rules = RULES[platform];
  const k8s = info.kubernetes;
  const componentLabel = k8s?.componentLabel ?? {};
  const sas = cluster.objects.service_account;
  const policies = values(cluster, "network_policy");
  const unique = (rules: string[]) => [...new Set(rules)];

  const view = (p: InfraPod, group: PodView["group"], title: string): PodView => {
    const sa = p.serviceAccount ? (sas.get(p.serviceAccount) ?? { name: p.serviceAccount, identity: {} }) : null;
    const main = p.containers.filter((c) => c.role !== "init");
    return {
      name: p.name,
      group,
      title,
      status: podStatus(p),
      phase: p.phase,
      terminating: p.terminating,
      ready: p.ready,
      runtime: group === "coding_run" ? rules.sandbox(runtimeName(p.runtimeClass)) : runtimeName(p.runtimeClass),
      sandboxed: p.runtimeClass !== null,
      node: p.node,
      identity: rules.identity(sa),
      containers: p.containers,
      runSha: group === "coding_run" && k8s ? (p.labels[k8s.runLabel] ?? null) : null,
      egress: unique(policies.filter((np) => selects(np, p.labels)).flatMap((np) => np.egress)),
      policies: policies.filter((np) => selects(np, p.labels)).map((np) => np.name),
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

  // The server writes one policy per run, so the same rules repeat across them.
  const egressRules = unique(
    policies
      .filter((np) => matches(componentLabel, np.podSelector as Record<string, string>))
      .flatMap((np) => np.egress),
  );

  const stores = values(cluster, "secret_store");
  const secretError = cluster.kindErrors.secret;
  const forbidden = secretError?.kind === "forbidden";
  const all = [...alwaysOn, ...codingRuns, ...jobs];

  return {
    platform,
    controlPlane:
      alwaysOn.some((p) => p.title === "control-plane") || !cluster.podsSynced // unknown until the pod snapshot arrives
        ? { inCluster: true }
        : { inCluster: false, location: hostPort(opts.serverUrl) },
    edge: edges.map((e) => rules.edge(e, { backendPolicies: values(cluster, "backend_policy") })),
    groups: { alwaysOn, codingRuns, jobs },
    isolation: {
      egressRules,
      sandbox: rules.sandbox(runtimeName(k8s?.runtimeClass ?? null)),
      policies: { count: policies.length, defaultDeny: policies.some(deniesAll) },
    },
    dataStores: [rules.database(alwaysOn)],
    secrets: {
      source: rules.secrets(stores),
      names: secretError ? null : values(cluster, "secret").map((s) => s.name),
      forbidden,
    },
    totals: {
      pods: all.length,
      codingRuns: codingRuns.length,
      readyContainers: all.reduce((s, p) => s + p.containers.filter((c) => c.ready && countsTowardReady(c)).length, 0),
      cpuMillis: all.reduce((s, p) => s + p.requests.cpuMillis, 0),
      memoryMiB: all.reduce((s, p) => s + p.requests.memoryMiB, 0),
    },
  };
}
