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

const CLUSTER_ERROR_KINDS = new Set([
  "no_kubeconfig",
  "context_not_found",
  "auth_plugin",
  "forbidden",
  "namespace_not_found",
  "unreachable",
  "other",
]);

/** True for the `{ kind, ... }` objects the cluster commands reject with. */
export function isClusterError(e: unknown): e is ClusterError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === "string" &&
    CLUSTER_ERROR_KINDS.has((e as { kind: string }).kind)
  );
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
