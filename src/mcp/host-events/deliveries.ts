/**
 * Shared housekeeping for the HostEventDelivery dedupe table. Every host
 * ingress (GitHub, Jira) calls this after recording a delivery; one process
 * clock keeps the prune to at most once an hour regardless of provider.
 */
import type { PrismaClient } from "#prisma";
import { logger } from "../../core/logger.js";

const log = logger.child({ module: "host-event-deliveries" });
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

export async function maybePruneHostEventDeliveries(
  db: Pick<PrismaClient, "hostEventDelivery">,
  now: Date,
): Promise<void> {
  if (now.getTime() - lastPruneAt <= PRUNE_INTERVAL_MS) return;
  lastPruneAt = now.getTime();
  await db.hostEventDelivery
    .deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) } } })
    .catch((err: unknown) => log.warn({ err }, "delivery prune failed"));
}

/** Test-only: reset the prune clock. */
export function resetPruneClockForTests(): void {
  lastPruneAt = 0;
}
