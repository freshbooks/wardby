import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";

const warn = vi.hoisted(() => vi.fn());
vi.mock("./logger.js", () => ({ logger: { child: () => ({ warn, info: vi.fn(), error: vi.fn() }) } }));
const apiCtor = vi.hoisted(() => vi.fn());
vi.mock("../providers/jobs/kubernetes-client.js", () => ({
  ClientNodeKubernetesApi: class {
    constructor(opts: unknown) {
      apiCtor(opts);
    }
    async readDeployment() {
      return undefined;
    }
  },
}));

import { buildPower } from "./power-composition.js";
import { DISABLED_POWER } from "./power.js";

const db = {} as PrismaClient;
afterEach(() => {
  warn.mockClear();
  apiCtor.mockClear();
});

describe("buildPower", () => {
  it("is DISABLED_POWER with no side effects when the flag is off", () => {
    expect(buildPower({ env: {}, db })).toBe(DISABLED_POWER);
    expect(buildPower({ env: { WARDBY_LOW_POWER: "0", JOB_LAUNCHER: "kubernetes" }, db })).toBe(DISABLED_POWER);
    expect(apiCtor).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and stays disabled when the launcher is not kubernetes", () => {
    expect(buildPower({ env: { WARDBY_LOW_POWER: "1", JOB_LAUNCHER: "docker" }, db })).toBe(DISABLED_POWER);
    expect(warn).toHaveBeenCalledWith("low_power_ignored: WARDBY_LOW_POWER requires JOB_LAUNCHER=kubernetes");
    expect(apiCtor).not.toHaveBeenCalled();
  });

  it("is enabled with a Kubernetes client for the configured context", () => {
    const power = buildPower({
      env: { WARDBY_LOW_POWER: "1", JOB_LAUNCHER: "kubernetes", KUBERNETES_CONTEXT: "ctx" },
      db,
    });
    expect(power.enabled).toBe(true);
    expect(apiCtor).toHaveBeenCalledWith({ context: "ctx" });
  });
});
