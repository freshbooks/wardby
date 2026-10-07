// Mirrors of the Rust cluster structs (serde camelCase) and frames. Keep in
// step with src-tauri/src/cluster/{model,watch,errors}.rs.
export type ClusterKind =
  | "pod"
  | "deployment"
  | "job"
  | "service"
  | "service_account"
  | "network_policy"
  | "ingress"
  | "gateway"
  | "http_route"
  | "backend_policy"
  | "secret_store"
  | "external_secret"
  | "secret";

export const CLUSTER_KINDS: readonly ClusterKind[] = [
  "pod",
  "deployment",
  "job",
  "service",
  "service_account",
  "network_policy",
  "ingress",
  "gateway",
  "http_route",
  "backend_policy",
  "secret_store",
  "external_secret",
  "secret",
];

/** Mirrors the Rust `ClusterError`, tagged by `kind` (no `message` on every variant). */
export type ClusterError =
  | { kind: "no_kubeconfig" }
  | { kind: "context_not_found"; context: string }
  | { kind: "auth_plugin"; message: string }
  | { kind: "forbidden"; resource: string }
  | { kind: "namespace_not_found"; namespace: string }
  | { kind: "unreachable"; message: string }
  | { kind: "other"; message: string };

/** Each ClusterError kind and the string field it must carry (if any). */
const CLUSTER_ERROR_FIELDS: Record<ClusterError["kind"], string | null> = {
  no_kubeconfig: null,
  context_not_found: "context",
  auth_plugin: "message",
  forbidden: "resource",
  namespace_not_found: "namespace",
  unreachable: "message",
  other: "message",
};

/**
 * True for the `{ kind, ... }` objects the cluster commands reject with. A wardby
 * server `AppError` can share a kind name ("forbidden"), so the kind's own field
 * must be present too (an AppError forbidden has no `resource`).
 */
export function isClusterError(e: unknown): e is ClusterError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !Object.hasOwn(CLUSTER_ERROR_FIELDS, kind)) return false;
  const field = CLUSTER_ERROR_FIELDS[kind as ClusterError["kind"]];
  return field === null || typeof (e as Record<string, unknown>)[field] === "string";
}

export interface Resources {
  cpu: string | null;
  memory: string | null;
}
export interface Owner {
  kind: string;
  name: string;
}
export interface InfraContainer {
  name: string;
  role: string;
  image: string;
  state: string;
  reason: string | null;
  ready: boolean;
  restarts: number;
  requests: Resources;
  limits: Resources;
}
export interface InfraPod {
  name: string;
  phase: string;
  labels: Record<string, string>;
  owner: Owner | null;
  node: string | null;
  runtimeClass: string | null;
  serviceAccount: string | null;
  startedAt: string | null;
  ready: boolean;
  /** The pod has a deletion timestamp: it is shutting down. */
  terminating: boolean;
  containers: InfraContainer[];
}
export interface InfraDeployment {
  name: string;
  ready: number;
  desired: number;
  labels: Record<string, string>;
}
export interface InfraJob {
  name: string;
  active: number;
  succeeded: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  labels: Record<string, string>;
}
export interface InfraEdge {
  kind: string;
  name: string;
  class: string | null;
  hosts: string[];
  annotations: Record<string, string>;
  /** An HTTPRoute whose rules only redirect (no backends). */
  redirectOnly: boolean;
  redirectScheme: string | null;
  /** Service names an HTTPRoute sends traffic to. */
  backends: string[];
}

/** A GKE GCPBackendPolicy: what it targets and its Cloud Armor policy. */
export interface InfraBackendPolicy {
  name: string;
  targetKind: string | null;
  targetName: string | null;
  securityPolicy: string | null;
}
export interface InfraService {
  name: string;
  serviceType: string;
  ports: string[];
  /** Set only for a LoadBalancer service. */
  edge: InfraEdge | null;
}
export interface InfraServiceAccount {
  name: string;
  identity: Record<string, string>;
}
export interface InfraNetworkPolicy {
  name: string;
  podSelector: Record<string, string>;
  policyTypes: string[];
  /** The pod selector is empty, so the policy selects every pod. */
  selectsAll: boolean;
  ingressRules: number;
  egress: string[];
}
export interface InfraSecretStore {
  name: string;
  provider: string | null;
}
export interface InfraExternalSecret {
  name: string;
  store: string | null;
  target: string | null;
}
export interface InfraSecretName {
  name: string;
}
export interface InfraEvent {
  at: string | null;
  kind: string;
  reason: string;
  message: string;
}

export interface KindItems {
  pod: InfraPod;
  deployment: InfraDeployment;
  job: InfraJob;
  service: InfraService;
  service_account: InfraServiceAccount;
  network_policy: InfraNetworkPolicy;
  ingress: InfraEdge;
  gateway: InfraEdge;
  http_route: InfraEdge;
  backend_policy: InfraBackendPolicy;
  secret_store: InfraSecretStore;
  external_secret: InfraExternalSecret;
  secret: InfraSecretName;
}
export type KindItem<K extends ClusterKind> = KindItems[K];

/** Mirrors the Rust `ClusterFrame`, tagged by `type`. Items are validated by shape, not type. */
export type ClusterFrame =
  | { type: "snapshot"; kind: ClusterKind; items: unknown[] }
  | { type: "applied"; kind: ClusterKind; item: unknown }
  | { type: "deleted"; kind: ClusterKind; name: string }
  | { type: "kind_error"; kind: ClusterKind; error: ClusterError }
  | { type: "status"; connected: boolean; error: ClusterError | null };

export interface ClusterPayload {
  server: string;
  frame: ClusterFrame;
}

export interface ClusterState {
  connected: boolean;
  error: ClusterError | null;
  /** Objects by kind, keyed by name. */
  objects: { [K in ClusterKind]: Map<string, KindItem<K>> };
  kindErrors: Partial<Record<ClusterKind, ClusterError>>;
  /** The pod list's initial snapshot has arrived on this connection (so an empty pod map is real). */
  podsSynced: boolean;
}
