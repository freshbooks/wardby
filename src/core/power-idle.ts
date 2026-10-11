/**
 * Low-power mode's idle rules: whether the coding proxy or native gateway has
 * had work since `since`. A target is busy while any of its runs is pending
 * (queued included) or running, or finished at or after `since`; the gateway
 * is also busy while any gateway session is active.
 */
import type { PrismaClient, RunStatus } from "#prisma";
import type { PowerTarget } from "./power.js";

const ACTIVE = { in: ["pending", "running"] as RunStatus[] };

export async function proxyBusy(db: PrismaClient, since: Date): Promise<boolean> {
  const n = await db.codingRun.count({
    where: { run: { OR: [{ status: ACTIVE }, { finishedAt: { gte: since } }] } },
  });
  return n > 0;
}

export async function gatewayBusy(db: PrismaClient, since: Date): Promise<boolean> {
  const runs = await db.run.count({
    where: { nativeExecutionMode: "sandbox", OR: [{ status: ACTIVE }, { finishedAt: { gte: since } }] },
  });
  if (runs > 0) return true;
  return (await db.nativeGatewaySession.count({ where: { status: "active" } })) > 0;
}

export function powerBusy(db: PrismaClient): (target: PowerTarget, since: Date) => Promise<boolean> {
  return (target, since) => (target === "proxy" ? proxyBusy(db, since) : gatewayBusy(db, since));
}
