import { describe as suite, expect, it } from "vitest";
import { describe, parseCpu, parseMemory, platformOf } from "./adapter";
import {
  clusterOf,
  container,
  genericCluster,
  genericInfo,
  gkeCluster,
  gkeInfo,
  kindCluster,
  kindInfo,
  pod,
} from "./fixtures";

suite("describe", () => {
  it("labels a GKE footprint", () => {
    const m = describe(gkeCluster, gkeInfo);
    expect(m.platform).toBe("gke");
    expect(m.edge[0]).toMatchObject({ label: "Gateway", detail: expect.arrayContaining(["Cloud Armor", "TLS"]) });
    expect(m.dataStores[0]).toMatchObject({ label: "Cloud SQL" });
    expect(m.secrets.source).toBe("Secret Manager");
    expect(m.groups.alwaysOn.map((p) => p.title)).toEqual(["control-plane", "coding-proxy", "headroom"]);
    expect(m.groups.alwaysOn[0].identity).toBe("GSA wardby-app@project.iam.gserviceaccount.com");
    expect(m.groups.codingRuns[0]).toMatchObject({
      runtime: "gVisor",
      runSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(m.groups.jobs.map((p) => p.title)).toEqual(["wardby-migrate"]);
    expect(m.isolation.egressRules).toEqual(["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"]);
    expect(m.isolation.sandbox).toBe("gVisor");
  });

  it("falls back to plain names on an unknown cluster", () => {
    const m = describe(genericCluster, genericInfo);
    expect(m.platform).toBe("generic");
    expect(m.edge[0]).toMatchObject({ label: "Ingress", hosts: ["wardby.example.com"] });
    expect(m.dataStores[0]).toMatchObject({ label: "Postgres (external)" });
    expect(m.groups.alwaysOn[0].identity).toBe("SA wardby");
    expect(m.secrets.source).toBeNull();
  });

  it("uses a Service's edge for generic LoadBalancer edges", () => {
    const c = clusterOf({
      service: [
        {
          name: "lb",
          serviceType: "LoadBalancer",
          ports: ["80/TCP"],
          edge: { kind: "loadbalancer", name: "lb", class: null, hosts: ["203.0.113.1"], annotations: {} },
        },
        { name: "internal", serviceType: "ClusterIP", ports: [], edge: null },
      ],
    });
    const m = describe(c, genericInfo);
    expect(m.edge).toHaveLength(1);
    expect(m.edge[0]).toMatchObject({ label: "Load Balancer", hosts: ["203.0.113.1"] });
  });

  it("hides secret names when secrets are forbidden", () => {
    const c = {
      ...gkeCluster,
      kindErrors: { secret: { kind: "forbidden", resource: "secrets" } },
    } as typeof gkeCluster;
    expect(describe(c, gkeInfo).secrets.names).toBeNull();
    expect(describe(gkeCluster, gkeInfo).secrets.names).toEqual(["wardby-db", "wardby-oauth"]);
  });

  it("omits pods outside wardby's footprint", () => {
    const m = describe(gkeCluster, gkeInfo);
    const all = [...m.groups.alwaysOn, ...m.groups.codingRuns, ...m.groups.jobs].map((p) => p.name);
    expect(all).not.toContain("unrelated-pod");
    expect(m.totals.pods).toBe(5);
  });

  it("totals requests", () => {
    const c = clusterOf({
      pod: [
        pod("wardby-control-plane-1-a", {
          owner: { kind: "ReplicaSet", name: "wardby-control-plane-1" },
          containers: [
            container({ requests: { cpu: "500m", memory: "512Mi" } }),
            container({ name: "x", role: "init", requests: { cpu: "1", memory: "1Gi" } }),
          ],
        }),
        pod("wardby-run-1", {
          labels: { "wardby.io/component": "coding-run" },
          containers: [container({ requests: { cpu: "2", memory: "4Gi" } })],
        }),
      ],
    });
    const m = describe(c, genericInfo);
    expect(m.totals).toMatchObject({ pods: 2, codingRuns: 1, readyContainers: 3, cpuMillis: 2500, memoryMiB: 4608 });
  });

  it("platformOf never returns eks", () => {
    expect(platformOf(gkeInfo, gkeCluster)).toBe("gke");
    expect(platformOf(genericInfo, genericCluster)).toBe("generic");
  });

  it("detects gke-autopilot by platform without the SA annotation", () => {
    expect(platformOf(gkeInfo, genericCluster)).toBe("gke");
  });

  it("detects GKE by the SA annotation when platform is generic", () => {
    expect(platformOf(genericInfo, gkeCluster)).toBe("gke");
  });
});

suite("quantities", () => {
  it("parses cpu", () => {
    expect(parseCpu("500m")).toBe(500);
    expect(parseCpu("2")).toBe(2000);
    expect(parseCpu("0.5")).toBe(500);
    expect(parseCpu(null)).toBe(0);
  });
  it("parses memory to MiB", () => {
    expect(parseMemory("512Mi")).toBe(512);
    expect(parseMemory("4Gi")).toBe(4096);
    expect(parseMemory("1G")).toBeCloseTo(953.674, 2);
    expect(parseMemory("1048576")).toBe(1);
    expect(parseMemory("1024Ki")).toBe(1);
    expect(parseMemory(null)).toBe(0);
  });
});

suite("kind and out-of-cluster control planes", () => {
  it("labels a kind cluster with the control plane outside it", () => {
    const m = describe(kindCluster, kindInfo, {
      serverUrl: "http://127.0.0.1:18080/mcp",
      context: "kind-wardby-coding",
    });
    expect(m.platform).toBe("kind");
    expect(m.controlPlane).toEqual({ inCluster: false, location: "127.0.0.1:18080" });
    expect(m.edge).toEqual([]);
    expect(m.groups.alwaysOn.map((p) => p.title)).toEqual(["coding-proxy"]);
    expect(m.groups.codingRuns[0].runtime).toBe("none (container runtime)");
    expect(m.dataStores[0].label).toBe("Postgres (external)");
  });

  it("detects kind from the context name or node names", () => {
    expect(platformOf(genericInfo, kindCluster, { context: "kind-dev" })).toBe("kind");
    expect(platformOf(genericInfo, kindCluster, {})).toBe("kind");
    expect(platformOf(genericInfo, genericCluster, { context: "prod" })).toBe("generic");
  });

  it("keeps the control plane in-cluster on GKE", () => {
    expect(describe(gkeCluster, gkeInfo).controlPlane).toEqual({ inCluster: true });
  });

  it("reports an outside control plane on any platform", () => {
    const m = describe(clusterOf({}), genericInfo, {
      serverUrl: "https://wardby.internal:8443/x",
    });
    expect(m.controlPlane).toEqual({ inCluster: false, location: "wardby.internal:8443" });
  });
});
