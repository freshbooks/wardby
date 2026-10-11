/**
 * Builds the process's single low-power `Power` from the environment. Every
 * composition root (serve, mcp, scheduler) calls this once and hands the same
 * instance to both executors, so wake and sleep agree on state.
 */
import type { PrismaClient } from "#prisma";
import { DEFAULT_NATIVE_GATEWAY_SERVICE, loadKubernetesJobConfig } from "../config/providers.js";
import { loadLowPowerConfig } from "../config/low-power.js";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import { logger } from "./logger.js";
import { createPower, DISABLED_POWER, type Power } from "./power.js";
import { powerBusy } from "./power-idle.js";

const log = logger.child({ module: "power-composition" });

export function buildPower({ env = process.env, db }: { env?: NodeJS.ProcessEnv; db: PrismaClient }): Power {
  const config = loadLowPowerConfig(env);
  if (!config.enabled) return DISABLED_POWER;
  if (env.JOB_LAUNCHER !== "kubernetes") {
    log.warn("low_power_ignored: WARDBY_LOW_POWER requires JOB_LAUNCHER=kubernetes");
    return DISABLED_POWER;
  }
  const kubernetes = loadKubernetesJobConfig(env);
  return createPower({
    config,
    api: new ClientNodeKubernetesApi({ context: kubernetes.context }),
    namespace: kubernetes.namespace,
    deployments: {
      proxy: kubernetes.proxyService,
      gateway: env.NATIVE_GATEWAY_SERVICE?.trim() || DEFAULT_NATIVE_GATEWAY_SERVICE,
    },
    busy: powerBusy(db),
  });
}
