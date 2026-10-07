/**
 * Level A load test: the control plane's database hot spots, in process,
 * against a throwaway PostgreSQL database. No model calls, no containers.
 *
 *   S1 scheduler   findDueCandidates with N scheduled agents (1% due)
 *   S2 dispatch    C concurrent coding dispatches, ungrouped vs grouped
 *                  (grouped takes the BudgetGroup table lock), split across
 *                  R simulated replicas (one Prisma pool each)
 *   S3 slots       N concurrent claimProvisioning calls against a cap of K
 *   S4 heartbeat   R active runs heartbeating every 250 ms
 *
 * Run it through scripts/load/run-level-a.sh, which creates, migrates and
 * drops the database. Refuses any DATABASE_URL whose database name does not
 * contain "load": it creates and deletes rows freely.
 */
import { performance } from "node:perf_hooks";
import type { PrismaClient } from "#prisma";
import { createPrismaClient } from "../../src/core/db.js";
import { dispatchRun } from "../../src/core/dispatch.js";
import { findDueCandidates } from "../../src/core/scheduler.js";
import { PrismaContainerExecutionStore } from "../../src/providers/executor/container.js";
import type { Executor } from "../../src/providers/executor/types.js";

const url = process.env.DATABASE_URL;
if (!url || !/load/.test(new URL(url).pathname)) {
  console.error('Refusing to run: DATABASE_URL must name a throwaway database containing "load".');
  process.exit(2);
}

const QUICK = process.env.LOAD_QUICK === "1";
const POOL_MAX = Number(process.env.LOAD_POOL_MAX ?? 10);
const REPLICAS = Number(process.env.LOAD_REPLICAS ?? 2);
const OWNER = "load-owner";
/** Comma-separated overrides, e.g. LOAD_DISPATCH_LEVELS=500,1000. LOAD_SCENARIOS=S2,S3 runs a subset. */
const levels = (name: string, fallback: number[]): number[] =>
  process.env[name] ? process.env[name]!.split(",").map(Number) : fallback;
const SCENARIOS = new Set((process.env.LOAD_SCENARIOS ?? "S1,S2,S3,S4").split(","));

const clients: PrismaClient[] = Array.from({ length: REPLICAS }, () => createPrismaClient(url, { poolMax: POOL_MAX }));
const db = clients[0]!;
const noopExecutor: Executor = { async start() {}, async stop() {} };

interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  wallMs: number;
}

function stats(samples: number[], wallMs: number): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? 0, wallMs };
}

const ms = (v: number) => v.toFixed(1);

/** Short error class for the notes column: Prisma code or the first words of the message. */
function errorKind(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code) return e.code;
  return (
    (e?.message ?? String(err))
      .split("\n")
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 60) ?? "unknown"
  );
}

function summarize(errors: Map<string, number>): string {
  return [...errors].map(([k, v]) => `${v}× ${k}`).join(", ");
}
const rows: string[] = [];
function row(scenario: string, params: string, st: Stats, extra = ""): void {
  const line = `| ${scenario} | ${params} | ${st.n} | ${ms(st.p50)} | ${ms(st.p95)} | ${ms(st.max)} | ${ms(st.wallMs)} | ${extra} |`;
  rows.push(line);
  console.log(line);
}

async function timed<T>(fn: () => Promise<T>, samples: number[]): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    samples.push(performance.now() - t0);
  }
}

async function reset(): Promise<void> {
  await db.codingRun.deleteMany({});
  await db.run.deleteMany({ where: { parentRunId: { not: null } } });
  await db.run.deleteMany({});
  await db.codingAgentProfile.deleteMany({});
  await db.agent.deleteMany({});
  await db.budgetGroup.deleteMany({});
}

async function codingAgents(prefix: string, count: number, budgetGroupId: string | null): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
  await db.agent.createMany({
    data: ids.map((id) => ({
      id,
      name: id,
      systemPrompt: "Fix things.",
      model: "gpt-5.6-luna",
      budgetUsd: 1,
      kind: "coding" as const,
      ownerId: OWNER,
      budgetGroupId,
    })),
  });
  await db.codingAgentProfile.createMany({
    data: ids.map((agentId) => ({
      agentId,
      provider: "codex",
      repository: "openai/example",
      defaultTask: "Fix it.",
      protectedPaths: [],
    })),
  });
  return ids;
}

/** S1: the scheduler's due check, which loads every scheduled agent and filters in JS. */
async function scenarioScheduler(): Promise<void> {
  const sizes = levels("LOAD_SCHEDULER_LEVELS", QUICK ? [100, 1000] : [100, 1000, 5000, 10000]);
  const now = new Date();
  for (const n of sizes) {
    await reset();
    const due = Math.max(1, Math.floor(n / 100));
    const batch = 1000;
    for (let start = 0; start < n; start += batch) {
      const data = [];
      for (let i = start; i < Math.min(n, start + batch); i++) {
        data.push({
          id: `sched-${i}`,
          name: `sched-${i}`,
          systemPrompt: "t",
          model: "t",
          budgetUsd: 1,
          ownerId: OWNER,
          scheduleEnabled: true,
          schedule: "*/5 * * * *",
          // Due agents last fired an hour ago; the rest fired just now.
          lastScheduledAt: i < due ? new Date(now.getTime() - 3_600_000) : now,
        });
      }
      await db.agent.createMany({ data });
    }
    const samples: number[] = [];
    let found = 0;
    await findDueCandidates(db, now); // warm-up
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) found = (await timed(() => findDueCandidates(db, now), samples)).length;
    row(
      "S1 scheduler due-check",
      `${n} scheduled agents`,
      stats(samples, performance.now() - t0),
      `${found} due (expected ${due}); per 10 s tick`,
    );
  }
}

/** S2: concurrent coding dispatches spread over the simulated replicas. */
async function scenarioDispatch(): Promise<void> {
  const counts = levels("LOAD_DISPATCH_LEVELS", QUICK ? [10, 50] : [10, 50, 100, 200]);
  for (const grouped of [false, true]) {
    for (const c of counts) {
      await reset();
      let groupId: string | null = null;
      if (grouped) {
        groupId = (await db.budgetGroup.create({ data: { name: `g-${c}`, ownerId: OWNER, dailyBudgetUsd: 100_000 } }))
          .id;
      }
      const agents = await codingAgents(`disp-${grouped ? "g" : "u"}-${c}`, c, groupId);
      const samples: number[] = [];
      let failed = 0;
      const errors = new Map<string, number>();
      const t0 = performance.now();
      await Promise.all(
        agents.map((agentId, i) =>
          timed(
            () => dispatchRun({ db: clients[i % REPLICAS]!, executor: noopExecutor, agentId, trigger: "webhook" }),
            samples,
          ).catch((err) => {
            failed++;
            errors.set(errorKind(err), (errors.get(errorKind(err)) ?? 0) + 1);
          }),
        ),
      );
      const wall = performance.now() - t0;
      const pending = await db.run.count({ where: { status: "pending" } });
      row(
        `S2 dispatch (${grouped ? "grouped: table lock" : "ungrouped"})`,
        `${c} at once, ${REPLICAS} replicas`,
        stats(samples, wall),
        `${pending} persisted, ${failed} errors${failed ? ` (${summarize(errors)})` : ""}; ${((c / wall) * 1000).toFixed(0)}/s`,
      );
    }
  }
}

/** S3: many runs racing for K coding slots (advisory lock + counts). */
async function scenarioSlots(): Promise<void> {
  const cap = 20;
  const counts = levels("LOAD_SLOT_LEVELS", QUICK ? [50] : [50, 200, 500]);
  for (const n of counts) {
    await reset();
    const agents = await codingAgents(`slot-${n}`, n, null);
    const runIds: string[] = [];
    for (const agentId of agents) {
      const r = await dispatchRun({ db, executor: noopExecutor, agentId, trigger: "webhook" });
      runIds.push(r!.run.id);
    }
    const stores = clients.map((c) => new PrismaContainerExecutionStore(c, { maxConcurrent: cap }));
    const samples: number[] = [];
    const outcomes: Record<string, number> = {};
    const errors = new Map<string, number>();
    const t0 = performance.now();
    await Promise.all(
      runIds.map(async (runId, i) => {
        try {
          const outcome = await timed(() => stores[i % REPLICAS]!.claimProvisioning(runId, `claim-${i}`), samples);
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        } catch (err) {
          errors.set(errorKind(err), (errors.get(errorKind(err)) ?? 0) + 1);
        }
      }),
    );
    const wall = performance.now() - t0;
    const active = await db.codingRun.count({ where: { jobBackend: { not: null } } });
    const ok = active <= cap ? "cap held" : "CAP EXCEEDED";
    row(
      "S3 slot claim",
      `${n} runs, cap ${cap}, ${REPLICAS} replicas`,
      stats(samples, wall),
      `claimed ${outcomes.claimed ?? 0}, queued ${outcomes.queued ?? 0}, unavailable ${outcomes.unavailable ?? 0}${errors.size ? `, errors ${summarize(errors)}` : ""}; ${active} active, ${ok}`,
    );
  }
}

/** S4: R active runs each heartbeating every 250 ms (the poll loop's fastest rate). */
async function scenarioHeartbeat(): Promise<void> {
  const counts = levels("LOAD_HEARTBEAT_LEVELS", QUICK ? [20, 100] : [20, 100, 300]);
  const durationMs = QUICK ? 3000 : 10_000;
  for (const r of counts) {
    await reset();
    const agents = await codingAgents(`hb-${r}`, r, null);
    const runIds: string[] = [];
    for (const agentId of agents) {
      const run = await dispatchRun({ db, executor: noopExecutor, agentId, trigger: "webhook" });
      runIds.push(run!.run.id);
    }
    await db.run.updateMany({ where: { id: { in: runIds } }, data: { status: "running" } });
    const stores = clients.map((c) => new PrismaContainerExecutionStore(c));
    const samples: number[] = [];
    const deadline = performance.now() + durationMs;
    const t0 = performance.now();
    await Promise.all(
      runIds.map(async (runId, i) => {
        while (performance.now() < deadline) {
          const started = performance.now();
          await timed(() => stores[i % REPLICAS]!.heartbeat(runId), samples);
          const wait = 250 - (performance.now() - started);
          if (wait > 0) await new Promise((res) => setTimeout(res, wait));
        }
      }),
    );
    const wall = performance.now() - t0;
    const target = (r * 1000) / 250;
    const achieved = (samples.length / wall) * 1000;
    row(
      "S4 heartbeat",
      `${r} active runs @ 250 ms`,
      stats(samples, wall),
      `${achieved.toFixed(0)} writes/s of ${target.toFixed(0)} target (${((achieved / target) * 100).toFixed(0)}%)`,
    );
  }
}

async function main(): Promise<void> {
  await db.principal.upsert({ where: { id: OWNER }, create: { id: OWNER, subject: OWNER }, update: {} });
  console.log(`Level A load test — pool ${POOL_MAX} per replica, ${REPLICAS} replicas${QUICK ? ", quick" : ""}\n`);
  console.log("| Scenario | Parameters | Samples | p50 ms | p95 ms | max ms | wall ms | Notes |");
  console.log("|---|---|---|---|---|---|---|---|");
  if (SCENARIOS.has("S1")) await scenarioScheduler();
  if (SCENARIOS.has("S2")) await scenarioDispatch();
  if (SCENARIOS.has("S3")) await scenarioSlots();
  if (SCENARIOS.has("S4")) await scenarioHeartbeat();
  await reset();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(clients.map((c) => c.$disconnect()));
  });
