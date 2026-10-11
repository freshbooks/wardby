import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { gatewayBusy, powerBusy, proxyBusy } from "./power-idle.js";

const since = new Date("2026-10-11T11:30:00Z");

/** A Prisma stub with only the count methods the idle rules call. */
function stubDb(counts: { codingRuns?: number; sandboxRuns?: number; sessions?: number } = {}) {
  const codingRunCount = vi.fn(async (_args: unknown) => counts.codingRuns ?? 0);
  const runCount = vi.fn(async (_args: unknown) => counts.sandboxRuns ?? 0);
  const sessionCount = vi.fn(async (_args: unknown) => counts.sessions ?? 0);
  const db = {
    codingRun: { count: codingRunCount },
    run: { count: runCount },
    nativeGatewaySession: { count: sessionCount },
  } as unknown as PrismaClient;
  return { db, codingRunCount, runCount, sessionCount };
}

describe("low-power idle rules (where clauses)", () => {
  it("proxyBusy counts coding runs that are active or finished since the window start", async () => {
    const { db, codingRunCount } = stubDb();
    expect(await proxyBusy(db, since)).toBe(false);
    expect(codingRunCount).toHaveBeenCalledWith({
      where: { run: { OR: [{ status: { in: ["pending", "running"] } }, { finishedAt: { gte: since } }] } },
    });
  });

  it("gatewayBusy is false with no sandbox run in the window and no active session", async () => {
    const { db, runCount, sessionCount } = stubDb();
    expect(await gatewayBusy(db, since)).toBe(false);
    expect(runCount).toHaveBeenCalledWith({
      where: {
        nativeExecutionMode: "sandbox",
        OR: [{ status: { in: ["pending", "running"] } }, { finishedAt: { gte: since } }],
      },
    });
    expect(sessionCount).toHaveBeenCalledWith({ where: { status: "active" } });
  });

  it("gatewayBusy is true on a sandbox run in the window, without checking sessions", async () => {
    const { db, sessionCount } = stubDb({ sandboxRuns: 1 });
    expect(await gatewayBusy(db, since)).toBe(true);
    expect(sessionCount).not.toHaveBeenCalled();
  });

  it("gatewayBusy is true on an active gateway session alone", async () => {
    const { db } = stubDb({ sessions: 1 });
    expect(await gatewayBusy(db, since)).toBe(true);
  });

  it("powerBusy routes each target to its rule", async () => {
    const { db, codingRunCount, runCount } = stubDb({ codingRuns: 2 });
    const busy = powerBusy(db);
    expect(await busy("proxy", since)).toBe(true);
    expect(await busy("gateway", since)).toBe(false);
    expect(codingRunCount).toHaveBeenCalledTimes(1);
    expect(runCount).toHaveBeenCalledTimes(1);
  });
});
