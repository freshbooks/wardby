/**
 * Low-power mode from the environment.
 *
 * WARDBY_LOW_POWER=1 lets the control plane scale idle GKE deployments to zero;
 * LOW_POWER_IDLE_MINUTES is how long they sit idle first. Unset/0 = off. See
 * docs/getting-started-gke.md "Low-power mode".
 */
export interface LowPowerConfig {
  enabled: boolean;
  idleMinutes: number;
}

const DEFAULT_IDLE_MINUTES = 30;

export function loadLowPowerConfig(env: NodeJS.ProcessEnv = process.env): LowPowerConfig {
  const flag = env.WARDBY_LOW_POWER?.trim();
  if (flag !== undefined && flag !== "" && flag !== "0" && flag !== "1") {
    throw new Error("WARDBY_LOW_POWER must be 0 or 1.");
  }
  // LOW_POWER_IDLE_MINUTES only matters with the mode on; off, it is ignored entirely.
  if (flag !== "1") return { enabled: false, idleMinutes: DEFAULT_IDLE_MINUTES };
  const raw = env.LOW_POWER_IDLE_MINUTES?.trim();
  if (!raw) return { enabled: true, idleMinutes: DEFAULT_IDLE_MINUTES };
  const idleMinutes = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(idleMinutes >= 5 && idleMinutes <= 1440)) {
    throw new Error("LOW_POWER_IDLE_MINUTES must be an integer from 5 to 1440.");
  }
  return { enabled: true, idleMinutes };
}
