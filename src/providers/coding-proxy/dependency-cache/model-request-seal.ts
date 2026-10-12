import { logger } from "../../../core/logger.js";
import type { DependencyCacheStore } from "./store.js";

const sealLog = logger.child({ module: "dependency-cache" });

/** Runs remembered as sealed per proxy process; the oldest are forgotten past this (a re-seal is a no-op write). */
const MAX_REMEMBERED_RUNS = 10_000;

/**
 * Seals a run's dependency-cache session on its first model request: the agent exists from that
 * request on, so the cache's pre-agent phase is over whatever the worker did (or failed to do).
 * The workers run the cache before they create the agent (Codex: driver.ts runs it before
 * startThread; Claude Code: driver.ts calls the prepare tool before createQuery), so no model
 * request precedes it. The seal is idempotent and conditional (only an unsealed session of a run
 * with the cache on), remembered per run in this process so it costs one write per run per proxy
 * replica, and never fails the model request: a database error is logged and retried on the
 * run's next request.
 */
export class ModelRequestSeal {
  private readonly sealed = new Set<string>();

  constructor(
    private readonly store: Pick<DependencyCacheStore, "sealForModelRequest">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async onModelRequest(runId: string): Promise<void> {
    if (this.sealed.has(runId)) return;
    try {
      await this.store.sealForModelRequest(runId, this.now());
    } catch (error) {
      sealLog.warn(
        { event: "dependency_cache.model_seal_failed", runId, err: error },
        "dependency cache: seal on the run's model request failed",
      );
      return;
    }
    this.sealed.add(runId);
    if (this.sealed.size > MAX_REMEMBERED_RUNS) {
      const oldest = this.sealed.values().next().value;
      if (oldest !== undefined) this.sealed.delete(oldest);
    }
  }
}
