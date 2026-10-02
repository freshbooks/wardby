/**
 * Per-run, per-model usage by priced token kind (RunModelUsage). Native runs
 * use one model (Agent.model), written once at finish; coding runs are
 * recomputed from the proxy ledger (prisma-ledger.ts). Always set, never
 * incremented, so a repeat is harmless. Best effort: Run.costUsd stays the
 * budget's source of truth.
 */
import type { PrismaClient } from "#prisma";
import type { EngineResult } from "../providers/engine/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "model-usage" });

export async function recordNativeModelUsage(
  db: Pick<PrismaClient, "runModelUsage">,
  runId: string,
  model: string,
  usage: EngineResult["usage"],
): Promise<void> {
  if (usage.tokensIn === 0 && usage.tokensOut === 0 && usage.costUsd === 0) return;
  const cached = usage.cachedInputTokens ?? 0;
  const values = {
    freshInputTokens: Math.max(0, usage.tokensIn - cached),
    cachedInputTokens: cached,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.tokensOut,
    costUsd: usage.costUsd,
  };
  try {
    await db.runModelUsage.upsert({
      where: { runId_model: { runId, model } },
      create: { runId, model, ...values },
      update: values,
    });
  } catch (err) {
    log.warn({ err, runId, model }, "could not record the run's model usage");
  }
}
