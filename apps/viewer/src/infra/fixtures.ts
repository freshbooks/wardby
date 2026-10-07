import type { InfraInfo } from "../api/types";
import { initialCluster } from "./state";
import type { ClusterKind, ClusterState, InfraContainer, InfraEdge, InfraPod, KindItems } from "./types";

// Neutral fixtures for the platform adapter and the Infrastructure tab.

export const RUN_SHA = "0123456789abcdef0123456789abcdef01234567";

const labels = {
  component: { "wardby.io/component": "coding-run" },
  managedBy: { "app.kubernetes.io/managed-by": "wardby" },
};

export const gkeInfo: InfraInfo = {
  launcher: "kubernetes",
  kubernetes: {
    namespace: "wardby",
    platform: "gke-autopilot",
    runtimeClass: "gvisor",
    proxyService: "wardby-coding-proxy",
    runLabel: "wardby.io/run-sha256",
    runLabelHashChars: 40,
    componentLabel: labels.component,
    managedByLabel: labels.managedBy,
  },
};

export const genericInfo: InfraInfo = {
  launcher: "kubernetes",
  kubernetes: { ...gkeInfo.kubernetes!, platform: "generic", runtimeClass: null },
};

export function container(over: Partial<InfraContainer> = {}): InfraContainer {
  return {
    name: "main",
    role: "main",
    image: "registry.example.com/wardby:1",
    state: "running",
    reason: null,
    ready: true,
    restarts: 0,
    requests: { cpu: "500m", memory: "512Mi" },
    limits: { cpu: null, memory: null },
    ...over,
  };
}

export function pod(name: string, over: Partial<InfraPod> = {}): InfraPod {
  return {
    name,
    phase: "Running",
    labels: {},
    owner: null,
    node: "node-1",
    runtimeClass: null,
    serviceAccount: null,
    startedAt: "2026-10-01T10:00:00Z",
    ready: true,
    containers: [container()],
    ...over,
  };
}

export function clusterOf(items: { [K in ClusterKind]?: KindItems[K][] }): ClusterState {
  const objects = { ...initialCluster.objects } as unknown as Record<string, Map<string, unknown>>;
  for (const [kind, list] of Object.entries(items)) {
    objects[kind] = new Map((list as { name: string }[]).map((i) => [i.name, i]));
  }
  return {
    ...initialCluster,
    connected: true,
    podsSynced: true,
    objects: objects as ClusterState["objects"],
    kindErrors: {},
  };
}

const gateway: InfraEdge = {
  kind: "gateway",
  name: "wardby-gateway",
  class: "gke-l7-global-external-managed",
  hosts: ["wardby.example.com"],
  annotations: { "networking.gke.io/security-policy": "your-project-armor" },
};

export const gkeCluster: ClusterState = clusterOf({
  gateway: [gateway],
  service_account: [
    {
      name: "wardby-app",
      identity: { "iam.gke.io/gcp-service-account": "wardby-app@project.iam.gserviceaccount.com" },
    },
  ],
  pod: [
    pod("wardby-control-plane-6d8f-abcde", {
      owner: { kind: "ReplicaSet", name: "wardby-control-plane-6d8f" },
      serviceAccount: "wardby-app",
      containers: [
        container({ name: "control-plane" }),
        container({
          name: "cloud-sql-proxy",
          role: "sidecar",
          image: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2",
          requests: { cpu: "100m", memory: "128Mi" },
        }),
      ],
    }),
    pod("wardby-coding-proxy-7c9d-fghij", {
      owner: { kind: "ReplicaSet", name: "wardby-coding-proxy-7c9d" },
      serviceAccount: "wardby-app",
    }),
    pod("wardby-headroom-5b4a-klmno", {
      owner: { kind: "ReplicaSet", name: "wardby-headroom-5b4a" },
      serviceAccount: "wardby-app",
    }),
    pod("wardby-run-abc123", {
      labels: { ...labels.component, "wardby.io/run-sha256": RUN_SHA },
      owner: null,
      runtimeClass: "gvisor",
      containers: [container({ name: "agent", requests: { cpu: "2", memory: "4Gi" } })],
    }),
    pod("wardby-migrate-xyz12", {
      phase: "Succeeded",
      ready: false,
      owner: { kind: "Job", name: "wardby-migrate" },
      containers: [container({ name: "migrate", ready: false, state: "terminated", reason: "Completed" })],
    }),
    pod("unrelated-pod", { containers: [container({ requests: { cpu: "4", memory: "8Gi" } })] }),
  ],
  network_policy: [
    {
      name: "wardby-run-egress",
      podSelector: labels.component,
      policyTypes: ["Egress"],
      egress: ["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"],
    },
    { name: "other", podSelector: { app: "other" }, policyTypes: ["Egress"], egress: ["anywhere"] },
  ],
  secret_store: [{ name: "wardby-store", provider: "gcpsm" }],
  secret: [{ name: "wardby-db" }, { name: "wardby-oauth" }],
});

export const genericCluster: ClusterState = clusterOf({
  ingress: [{ kind: "ingress", name: "wardby", class: "nginx", hosts: ["wardby.example.com"], annotations: {} }],
  service_account: [{ name: "wardby", identity: {} }],
  pod: [
    pod("wardby-control-plane-1-aaaaa", {
      owner: { kind: "ReplicaSet", name: "wardby-control-plane-1" },
      serviceAccount: "wardby",
    }),
  ],
});

export const kindInfo: InfraInfo = {
  launcher: "kubernetes",
  kubernetes: { ...gkeInfo.kubernetes!, namespace: "wardby-coding", platform: "generic", runtimeClass: null },
};

// deploy/kind-coding: the control plane runs on the developer's machine; only the proxy and run pods are in-cluster.
export const kindCluster: ClusterState = clusterOf({
  pod: [
    pod("wardby-coding-proxy-7c9d-fghij", {
      owner: { kind: "ReplicaSet", name: "wardby-coding-proxy-7c9d" },
      node: "wardby-coding-control-plane",
    }),
    pod("wardby-run-abc123", {
      labels: { ...labels.component, "wardby.io/run-sha256": RUN_SHA },
      node: "wardby-coding-control-plane",
      containers: [container({ name: "agent" })],
    }),
  ],
  network_policy: [
    { name: "default-deny", podSelector: {}, policyTypes: ["Ingress", "Egress"], egress: [] },
    {
      name: "wardby-run-egress",
      podSelector: labels.component,
      policyTypes: ["Egress"],
      egress: ["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"],
    },
  ],
});

export const RUN_SHA_2 = "fedcba9876543210fedcba9876543210fedcba98";
const PROXY_RULE = "pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP";

// The server creates one NetworkPolicy per run, selecting that run's pod by its run label.
const runPolicy = (sha: string, egress: string[]) => ({
  name: `wardby-run-${sha.slice(0, 8)}`,
  podSelector: { ...labels.component, "wardby.io/run-sha256": sha },
  policyTypes: ["Egress"],
  egress,
});

export const twoRunsCluster: ClusterState = clusterOf({
  pod: [
    pod("wardby-run-one", {
      labels: { ...labels.component, "wardby.io/run-sha256": RUN_SHA },
      runtimeClass: "gvisor",
      containers: [container({ name: "agent" })],
    }),
    pod("wardby-run-two", {
      labels: { ...labels.component, "wardby.io/run-sha256": RUN_SHA_2 },
      runtimeClass: "gvisor",
      containers: [container({ name: "agent" })],
    }),
  ],
  network_policy: [runPolicy(RUN_SHA, [PROXY_RULE]), runPolicy(RUN_SHA_2, [PROXY_RULE, "cidr 10.0.0.0/8 :443/TCP"])],
});
