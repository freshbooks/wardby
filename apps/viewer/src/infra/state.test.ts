import { describe, expect, it } from "vitest";
import { initialCluster, reduceCluster } from "./state";
import type { ClusterFrame, InfraPod } from "./types";

const pod = (name: string, phase = "Running"): InfraPod => ({
  name,
  phase,
  labels: {},
  owner: null,
  node: null,
  runtimeClass: null,
  serviceAccount: null,
  startedAt: null,
  ready: true,
  containers: [],
});
const apply = (frames: ClusterFrame[]) => frames.reduce(reduceCluster, initialCluster);

describe("reduceCluster", () => {
  it("snapshot replaces a kind, applied upserts, deleted removes", () => {
    let s = reduceCluster(initialCluster, { type: "snapshot", kind: "pod", items: [pod("a"), pod("b")] });
    s = reduceCluster(s, { type: "applied", kind: "pod", item: pod("b", "Succeeded") });
    s = reduceCluster(s, { type: "deleted", kind: "pod", name: "a" });
    expect([...s.objects.pod.keys()]).toEqual(["b"]);
    expect(s.objects.pod.get("b")!.phase).toBe("Succeeded");
  });

  it("an applied or deleted frame clears that kind's error (the watch is flowing again)", () => {
    const down = { kind: "unreachable" as const, message: "connection refused" };
    let s = apply([
      { type: "snapshot", kind: "pod", items: [pod("a")] },
      { type: "kind_error", kind: "pod", error: down },
      { type: "kind_error", kind: "job", error: down },
    ]);
    s = reduceCluster(s, { type: "applied", kind: "pod", item: pod("b") });
    expect(s.kindErrors.pod).toBeUndefined();
    expect(s.kindErrors.job).toEqual(down);
    s = reduceCluster(s, { type: "kind_error", kind: "pod", error: down });
    s = reduceCluster(s, { type: "deleted", kind: "pod", name: "a" });
    expect(s.kindErrors.pod).toBeUndefined();
  });

  it("updates one kind with a new Map and leaves the others shared", () => {
    const s = reduceCluster(initialCluster, { type: "applied", kind: "pod", item: pod("a") });
    expect(s.objects.pod).not.toBe(initialCluster.objects.pod);
    expect(s.objects.job).toBe(initialCluster.objects.job);
    expect(initialCluster.objects.pod.size).toBe(0);
  });

  it("a kind error is kept per kind and cleared by that kind's next snapshot", () => {
    const forbidden = { kind: "forbidden", resource: "secrets" } as const;
    let s = apply([
      { type: "kind_error", kind: "secret", error: forbidden },
      { type: "kind_error", kind: "pod", error: forbidden },
    ]);
    expect(s.kindErrors.secret).toEqual(forbidden);
    s = reduceCluster(s, { type: "snapshot", kind: "secret", items: [] });
    expect(s.kindErrors.secret).toBeUndefined();
    expect(s.kindErrors.pod).toEqual(forbidden);
  });

  it("status frames set connected and error", () => {
    const s = reduceCluster(initialCluster, { type: "status", connected: false, error: { kind: "no_kubeconfig" } });
    expect(s.connected).toBe(false);
    expect(s.error).toEqual({ kind: "no_kubeconfig" });
    const t = reduceCluster(s, { type: "status", connected: true, error: null });
    expect(t.connected).toBe(true);
    expect(t.error).toBeNull();
  });

  it("a connected status frame resets every kind and kind error (fresh connection)", () => {
    let s = apply([
      { type: "snapshot", kind: "pod", items: [pod("a")] },
      { type: "kind_error", kind: "secret", error: { kind: "forbidden", resource: "secrets" } },
    ]);
    s = reduceCluster(s, { type: "status", connected: true, error: null });
    expect(s.objects.pod.size).toBe(0);
    expect(s.kindErrors).toEqual({});
    expect(s.connected).toBe(true);
  });

  it("a disconnected status keeps the last known objects", () => {
    let s = reduceCluster(initialCluster, { type: "snapshot", kind: "pod", items: [pod("a")] });
    s = reduceCluster(s, { type: "status", connected: false, error: { kind: "unreachable", message: "x" } });
    expect(s.objects.pod.size).toBe(1);
  });

  it("drops malformed frames without throwing", () => {
    expect(reduceCluster(initialCluster, { type: "nope" } as never)).toBe(initialCluster);
    expect(reduceCluster(initialCluster, { type: "applied", kind: "bogus", item: pod("a") } as never)).toBe(
      initialCluster,
    );
    expect(reduceCluster(initialCluster, { type: "applied", kind: "pod", item: 3 } as never)).toBe(initialCluster);
    expect(reduceCluster(initialCluster, null as never)).toBe(initialCluster);
  });

  it("podsSynced follows the pod snapshot and resets on reconnect", () => {
    let s = reduceCluster(initialCluster, { type: "status", connected: true, error: null });
    expect(s.podsSynced).toBe(false);
    s = reduceCluster(s, { type: "snapshot", kind: "service_account", items: [] });
    expect(s.podsSynced).toBe(false);
    s = reduceCluster(s, { type: "snapshot", kind: "pod", items: [] });
    expect(s.podsSynced).toBe(true);
    s = reduceCluster(s, { type: "status", connected: true, error: null });
    expect(s.podsSynced).toBe(false);
  });
});
