/** Scheduler/executor/reconciler timing constants — one module, tunable. */

export const TICK_INTERVAL_MS = 10_000;
export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_INTERVAL_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
export const RECONCILE_INTERVAL_MS = 15_000;
/**
 * How long a lock-serialized transaction (dispatch, coding slot claim) waits
 * for a pooled connection before Prisma gives up with P2028. Prisma's default
 * is 2 s, which a burst of a few hundred grouped dispatches or claims queued
 * on one lock exceeds while every connection waits its turn.
 */
export const CONTENDED_TX_MAX_WAIT_MS = 10_000;
