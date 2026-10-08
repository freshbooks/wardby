/**
 * Builds the native sandbox executor from configuration (NATIVE_SANDBOX_*, docs/native-sandbox.md),
 * or nothing when the native sandbox is not configured — sandbox-mode runs then fail closed.
 */

import { loadNativeSandboxConfig } from "../config/providers.js";
import type { NativeRunProviders, RunnerDb } from "../core/runner.js";
import { nativeGatewayUrl } from "./docker-isolation.js";
import { DockerNativeWorkerLauncher } from "./docker-launcher.js";
import type { GatewayLedgerDb } from "./ledger.js";
import { NativeSandboxExecutor, type ManagedWorkerLauncher } from "./sandbox-executor.js";

export function buildNativeSandboxExecutor(options: {
  db: RunnerDb & GatewayLedgerDb;
  /** Read at call time: the composition root patches `executor` on after wrapping this one. */
  providers: NativeRunProviders;
  env?: NodeJS.ProcessEnv;
  /** Tests only: replaces the Docker launcher. */
  launcher?: ManagedWorkerLauncher;
}): NativeSandboxExecutor | undefined {
  const config = loadNativeSandboxConfig(options.env ?? process.env);
  if (!config) return undefined;
  const launcher =
    options.launcher ??
    new DockerNativeWorkerLauncher({
      image: config.workerImage,
      gatewayContainer: config.gatewayContainer,
      limits: { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids },
    });
  return new NativeSandboxExecutor({
    db: options.db,
    providers: options.providers,
    launcher,
    gatewayUrl: config.gatewayUrl ?? nativeGatewayUrl(),
  });
}
