import { describe, expect, it, vi } from "vitest";
import { FakeKubernetesApi } from "../providers/jobs/fake-kubernetes-api.js";
import { createPower, DISABLED_POWER, POWER_WOKE_AT, type PowerTarget } from "./power.js";

const NS = "wardby-coding";
const names = { proxy: "wardby-coding-proxy", gateway: "wardby-native-gateway" };
const readyEndpoints = { metadata: { name: names.proxy }, subsets: [{ addresses: [{ ip: "10.0.0.5" }] }] };

function setup(
  replicas: number,
  opts: {
    ready?: boolean;
    onSleep?: (calls: number, api: FakeKubernetesApi) => void;
    busy?: (target: PowerTarget, since: Date) => Promise<boolean>;
    /** Seeds the proxy Deployment's POWER_WOKE_AT annotation. */
    wokeAt?: string;
    enabled?: boolean;
  } = {},
) {
  const api = new FakeKubernetesApi();
  api.put("deployment", NS, {
    metadata: { name: names.proxy, ...(opts.wokeAt ? { annotations: { [POWER_WOKE_AT]: opts.wokeAt } } : {}) },
    spec: { replicas, selector: {}, template: {} },
  });
  if (opts.ready) api.put("endpoints", NS, readyEndpoints);
  let t = Date.parse("2026-10-11T12:00:00Z");
  let sleeps = 0;
  const power = createPower({
    config: { enabled: opts.enabled ?? true, idleMinutes: 30 },
    api,
    namespace: NS,
    deployments: names,
    busy: opts.busy,
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

describe("power (sleep)", () => {
  // setup()'s clock starts at 2026-10-11T12:00:00Z; idleMinutes is 30.
  const SIXTY_MIN_AGO = "2026-10-11T11:00:00Z";

  it("sleeps an idle target after the window", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches.at(-1)).toEqual({ name: names.proxy, replicas: 0 });
    expect(await power.isAsleep("proxy")).toBe(true);
    expect(busy).toHaveBeenCalledTimes(2); // check + re-check
    expect(busy).toHaveBeenCalledWith("proxy", new Date("2026-10-11T11:30:00Z"));
  });

  it("does not sleep a target woken less than idleMinutes ago", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: "2026-10-11T11:50:00Z" });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).not.toHaveBeenCalled();
  });

  it("counts from process start when the Deployment has no woke-at annotation", async () => {
    const busy = vi.fn(async () => false);
    const { api, power, advance } = setup(1, { busy });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    advance(31 * 60_000);
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([{ name: names.proxy, replicas: 0 }]);
  });

  it("does not sleep when busy", async () => {
    const busy = vi.fn(async () => true);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).toHaveBeenCalledTimes(1);
    expect(await power.isAsleep("proxy")).toBe(false);
  });

  it("does not sleep when the re-check finds a run", async () => {
    const busy = vi.fn<(target: PowerTarget, since: Date) => Promise<boolean>>();
    busy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).toHaveBeenCalledTimes(2);
  });

  it("leaves a target already at zero replicas alone", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(0, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).not.toHaveBeenCalled();
  });

  it("skips a target whose Deployment does not exist", async () => {
    // Only the proxy Deployment is seeded; the gateway one is missing.
    const busy = vi.fn(async (_target: PowerTarget, _since: Date) => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await expect(power.sleepIfIdle()).resolves.toBeUndefined();
    expect(busy.mock.calls.map(([target]) => target)).toEqual(["proxy", "proxy"]);
    expect(api.deploymentPatches).toEqual([{ name: names.proxy, replicas: 0 }]);
  });

  it("sleeps the gateway too when it is idle", async () => {
    const busy = vi.fn(async (target: PowerTarget) => target === "proxy");
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    api.put("deployment", NS, {
      metadata: { name: names.gateway, annotations: { [POWER_WOKE_AT]: SIXTY_MIN_AGO } },
      spec: { replicas: 1, selector: {}, template: {} },
    });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([{ name: names.gateway, replicas: 0 }]);
  });

  it("throttles to once per minute", async () => {
    const busy = vi.fn(async () => true);
    const { power, advance } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(busy).toHaveBeenCalledTimes(1);
    advance(10_000);
    await power.sleepIfIdle();
    expect(busy).toHaveBeenCalledTimes(1);
    advance(50_000);
    await power.sleepIfIdle();
    expect(busy).toHaveBeenCalledTimes(2);
  });

  it("swallows and logs API errors, per target", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    api.put("deployment", NS, {
      metadata: { name: names.gateway, annotations: { [POWER_WOKE_AT]: SIXTY_MIN_AGO } },
      spec: { replicas: 1, selector: {}, template: {} },
    });
    const read = api.readDeployment.bind(api);
    vi.spyOn(api, "readDeployment").mockImplementation(async (ns, name) => {
      if (name === names.proxy) throw new Error("apiserver down");
      return read(ns, name);
    });
    await expect(power.sleepIfIdle()).resolves.toBeUndefined();
    // The proxy's failure did not stop the gateway from sleeping.
    expect(api.deploymentPatches).toEqual([{ name: names.gateway, replicas: 0 }]);
  });

  it("swallows a busy-check failure and leaves the target up", async () => {
    const busy = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await expect(power.sleepIfIdle()).resolves.toBeUndefined();
    expect(api.deploymentPatches).toEqual([]);
  });

  it("does nothing without a busy check", async () => {
    const { api, power } = setup(1, { wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
  });

  it("is a no-op when disabled", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO, enabled: false });
    vi.spyOn(api, "readDeployment");
    await power.sleepIfIdle();
    expect(api.readDeployment).not.toHaveBeenCalled();
    expect(busy).not.toHaveBeenCalled();
    expect(api.deploymentPatches).toEqual([]);
  });
});
