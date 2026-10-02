/**
 * Persists launcher-observed coding-run service states (CodingRunServiceStatus, one row per
 * run x service) for the viewer and get_run. Composed into the job launchers by
 * providers/executor/composition.ts; launchers call it through reportServiceState, which drops
 * its errors.
 */
import type { PrismaClient } from "#prisma";
import type { ServiceStateReporter } from "../providers/jobs/service-state.js";

type ServiceStatusDb = Pick<PrismaClient, "codingRunServiceStatus">;

export function prismaServiceStateReporter(
  db: ServiceStatusDb,
  now: () => Date = () => new Date(),
): ServiceStateReporter {
  return async ({ runId, name, state, attempts, reason }) => {
    const at = now();
    const data = {
      state,
      attempts: attempts ?? null,
      reason: reason ?? null,
      readyAt: state === "ready" ? at : null,
      failedAt: state === "failed" ? at : null,
    };
    await db.codingRunServiceStatus.upsert({
      where: { runId_name: { runId, name } },
      create: { runId, name, ...data },
      update: data,
    });
  };
}
