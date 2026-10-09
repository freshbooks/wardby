/**
 * The native sandbox warm pool (phase 6, docs/native-sandbox.md).
 */

import type { NativeWorkerState } from "./docker-launcher.js";
import type { WorkerHandle } from "./launch.js";
import type { WorkerInput } from "./protocol.js";

/** What a launcher does for pool workers. Every operation is keyed by the worker's random token. */
export interface WarmWorkerLauncher {
  /** What its pool workers are built from (with the worker's wait): a claim takes only a matching one. */
  warmSpecHash(waitMs: number): string;
  /**
   * Creates a pool worker and proves its isolation, resolving once it is claimable. On failure it
   * removes what it created and throws.
   */
  startWarm(token: string, waitMs: number): Promise<void>;
  /** The claimed worker still runs, as built: cheap reads, not a new isolation probe. */
  reattestWarm(token: string, waitMs: number): Promise<boolean>;
  /** Writes the run's input into the worker over exec stdin (warm-delivery.ts). */
  deliver(token: string, input: WorkerInput): Promise<void>;
  warmHandle(token: string): WorkerHandle;
  inspectWarm(token: string): Promise<NativeWorkerState>;
  killWarm(token: string): Promise<void>;
  /** Removes the worker and everything made for it. Idempotent. */
  removeWarm(token: string): Promise<void>;
  /** The tokens of every pool worker this launcher holds, rows or not. */
  listWarm(): Promise<string[]>;
}
