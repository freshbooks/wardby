/** The run detail read model behind GET /admin/api/runs/:id (docs/viewer-api.md). */
import type { PrismaClient } from "#prisma";
import type { RunDetail } from "./api-schema.js";
import { loadGraphRuns } from "./graph.js";

type CodingDetail = NonNullable<RunDetail["coding"]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the CodingRun.services snapshot. Env values are never copied: names only, and serviceEnv is never read. */
function serviceDetails(snapshot: unknown): CodingDetail["services"] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.filter(isRecord).map((s) => ({
    name: String(s.name),
    version: String(s.version),
    image: String(s.image),
    envNames: isRecord(s.testEnv) ? Object.keys(s.testEnv).sort() : [],
  }));
}

export async function loadRunDetail(db: PrismaClient, runId: string): Promise<RunDetail | null> {
  const [graphRun] = await loadGraphRuns(db, [runId]);
  if (!graphRun) return null;
  const [row, children] = await Promise.all([
    db.run.findUniqueOrThrow({
      where: { id: runId },
      select: {
        error: true,
        finalText: true,
        agent: { select: { model: true } },
        codingRun: {
          select: {
            provider: true,
            repository: true,
            baseRef: true,
            headRef: true,
            model: true,
            queuedAt: true,
            failureCategory: true,
            services: true,
          },
        },
      },
    }),
    db.run.findMany({
      where: { parentRunId: runId },
      select: { id: true },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const coding = row.codingRun;
  return {
    ...graphRun,
    model: coding?.model ?? row.agent.model,
    error: row.error,
    finalText: row.finalText,
    childRunIds: children.map((c) => c.id),
    coding: coding
      ? {
          provider: coding.provider,
          repository: coding.repository,
          baseRef: coding.baseRef,
          headRef: coding.headRef,
          queuedAt: coding.queuedAt ? coding.queuedAt.toISOString() : null,
          failureCategory: coding.failureCategory,
          services: serviceDetails(coding.services),
        }
      : null,
  };
}
