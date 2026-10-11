import { describe, expect, it } from "vitest";
import { FakeKubernetesApi } from "../providers/jobs/fake-kubernetes-api.js";
import { createPower, DISABLED_POWER, POWER_WOKE_AT } from "./power.js";

const NS = "wardby-coding";
const names = { proxy: "wardby-coding-proxy", gateway: "wardby-native-gateway" };
const readyEndpoints = { metadata: { name: names.proxy }, subsets: [{ addresses: [{ ip: "10.0.0.5" }] }] };

function setup(
  replicas: number,
  opts: { ready?: boolean; onSleep?: (calls: number, api: FakeKubernetesApi) => void } = {},
) {
  const api = new FakeKubernetesApi();
  api.put("deployment", NS, { metadata: { name: names.proxy }, spec: { replicas, selector: {}, template: {} } });
  if (opts.ready) api.put("endpoints", NS, readyEndpoints);
  let t = Date.parse("2026-10-11T12:00:00Z");
  let sleeps = 0;
  const power = createPower({
    config: { enabled: true, idleMinutes: 30 },
    api,
    namespace: NS,
    deployments: names,
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
      opts.onSleep?.(++sleeps, api);
    },
    pollMs: 1000,
  });
  return { api, power, advance: (ms: number) => (t += ms) };
}

describe("power (wake)", () => {
  it("disabled power makes no API calls", async () => {
    const api = new FakeKubernetesApi();
    const power = createPower({ config: { enabled: false, idleMinutes: 30 }, api, namespace: NS, deployments: names });
    expect(power.enabled).toBe(false);
    await power.ensureAwake("proxy", { timeoutMs: 1000, runId: "r" });
    expect(api.deploymentPatches).toEqual([]);
    expect(await power.isAsleep("proxy")).toBe(false);
    expect(await power.checkAccess()).toEqual([]);
  });

  it("DISABLED_POWER is a no-op", async () => {
    expect(DISABLED_POWER.enabled).toBe(false);
    await DISABLED_POWER.ensureAwake("gateway", { timeoutMs: 1000, runId: "r" });
    await DISABLED_POWER.sleepIfIdle();
    expect(await DISABLED_POWER.isAsleep("gateway")).toBe(false);
    expect(await DISABLED_POWER.checkAccess()).toEqual([]);
  });

  it("wakes a deployment at 0, stamps woke-at, and waits for a ready endpoint", async () => {
    // The endpoint turns ready during the first poll wait, so the wake must poll at least once.
    const { api, power } = setup(0, {
      onSleep: (calls, fake) => {
        if (calls === 1) fake.put("endpoints", NS, readyEndpoints);
      },
    });
    await expect(power.ensureAwake("proxy", { timeoutMs: 60_000, runId: "r1" })).resolves.toBeUndefined();
    expect(api.deploymentPatches).toEqual([
      { name: names.proxy, replicas: 1, annotations: { [POWER_WOKE_AT]: "2026-10-11T12:00:00.000Z" } },
    ]);
    expect(await power.isAsleep("proxy")).toBe(false);
  });

  it("returns at once when already awake and ready", async () => {
    const { api, power } = setup(1, { ready: true });
    await power.ensureAwake("proxy", { timeoutMs: 1000, runId: "r" });
    expect(api.deploymentPatches).toEqual([]);
  });

  it("isAsleep reports a deployment at 0 replicas", async () => {
    const { power } = setup(0);
    expect(await power.isAsleep("proxy")).toBe(true);
  });

  it("fails with low_power_wake_timeout and leaves replicas at 1", async () => {
    const { api, power } = setup(0);
    await expect(power.ensureAwake("proxy", { timeoutMs: 5000, runId: "r" })).rejects.toThrow(
      /^low_power_wake_timeout: /,
    );
    expect((await api.readDeployment(NS, names.proxy))?.spec?.replicas).toBe(1);
  });

  it("fails fast with low_power_scale_forbidden", async () => {
    const { api, power } = setup(0);
    api.forbidden.add(names.proxy);
    await expect(power.ensureAwake("proxy", { timeoutMs: 5000, runId: "r" })).rejects.toThrow(
      /^low_power_scale_forbidden: .*wardby-coding-proxy/,
    );
  });

  it("two concurrent wakes both succeed", async () => {
    const { api, power } = setup(0, { ready: true });
    await Promise.all([
      power.ensureAwake("proxy", { timeoutMs: 5000, runId: "a" }),
      power.ensureAwake("proxy", { timeoutMs: 5000, runId: "b" }),
    ]);
    expect((await api.readDeployment(NS, names.proxy))?.spec?.replicas).toBe(1);
  });

  it("checkAccess lists missing permissions", async () => {
    const { api, power } = setup(1);
    api.accessDenied.add("patch/deployments/wardby-native-gateway");
    expect(await power.checkAccess()).toEqual(["patch deployments/wardby-native-gateway"]);
  });
});
