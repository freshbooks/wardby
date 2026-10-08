/**
 * Level B load test: N real coding-run pods on a local kind cluster, through
 * the real coding proxy, whose model upstream is a guarded mock
 * (src/providers/coding-proxy/mock-upstream.ts) that always answers
 * `outcome: "no_changes"` for Codex/OpenAI Responses requests (ruling R1).
 * Codex agents only.
 *
 * `wardby run` (the CLI) refuses coding agents on purpose, so trigger_agent
 * over MCP is the only way to start one -- this script spawns
 * LOAD_CONTROL_PLANES `wardby mcp` stdio children exactly as
 * scripts/local-trigger-agent.mjs does, and fires LOAD_RUNS trigger_agent
 * calls round-robin across them.
 *
 * Ruling R2 verified (see the PR description for file:line evidence): a run
 * triggered over `wardby mcp` stdio is driven to completion by an in-memory,
 * unawaited poll loop (ContainerExecutor.execute) living inside that same
 * stdio child process, with no setInterval/cron of its own -- `wardby mcp`
 * never starts the scheduler or reconciler. That loop only needs the child
 * process to stay alive, which this script's own get_run polling already
 * requires. The one `wardby serve` Task 6 starts separately supplies the
 * reconciler as a safety net (45 s heartbeat timeout) for a run whose owning
 * stdio child dies early; it plays no part in the common path.
 *
 * Run it through scripts/load/run-level-b.sh (Task 6), which creates the
 * throwaway database, the kind cluster/overlay, the single `wardby serve`,
 * and this script's env, then tears everything down after. Refuses any
 * DATABASE_URL whose database name does not contain "load" (same check as
 * Level A): it reads live cluster/DB state freely but never mutates rows
 * beyond what trigger_agent itself does.
 *
 * Resilience: every probe (kubectl, pg_stat_activity, the queue/active-slot
 * counts, get_run polling, the final per-run Run read) is individually
 * guarded, so a transient Kubernetes/Postgres/MCP hiccup degrades one
 * sample or one run's data rather than crashing the process. If the core
 * flow still fails unexpectedly, main() prints the table and writes
 * LOAD_OUT from whatever `runs`/`samples` it collected before the failure
 * (marked `incomplete`) and exits 1, instead of losing the run entirely.
 */
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { PrismaClient, RunStatus } from "#prisma";
import { createPrismaClient } from "../../src/core/db.js";
import { loadCodingConcurrencyConfig } from "../../src/config/providers.js";
import { kubernetesRunNames } from "../../src/providers/jobs/kubernetes-isolation.js";

// Not a byte-for-byte copy of Level A's bare /load/ test: that regex also
// matches "notload" (the substring "load" at the end of a non-"load" word),
// so "postgresql://x/notload" -- the exact refusal case the brief's dry
// check exercises -- would slip through it. This requires "load" to be its
// own segment (bounded by a non-alphanumeric character or the string's
// ends), which still accepts "wardby_load"/"wardby_load_b" but refuses
// "notload"/"payload"/"overload".
const LOAD_NAME = /(?:^|[^a-z0-9])load(?:[^a-z0-9]|$)/i;
const url = process.env.DATABASE_URL;
if (!url || !LOAD_NAME.test(new URL(url).pathname)) {
  console.error('Refusing to run: DATABASE_URL must name a throwaway database containing "load".');
  process.exit(2);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (set by scripts/load/run-level-b.sh).`);
  return v;
}
function requireEnvInt(name: string): number {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

const LOAD_RUNS = requireEnvInt("LOAD_RUNS");
const LOAD_CONTROL_PLANES = requireEnvInt("LOAD_CONTROL_PLANES");
const LOAD_AGENT_ID = requireEnv("LOAD_AGENT_ID");
const LOAD_OUT = requireEnv("LOAD_OUT");
const KUBERNETES_CONTEXT = requireEnv("KUBERNETES_CONTEXT");
const LOAD_NAMESPACE = process.env.LOAD_NAMESPACE ?? "wardby-coding";
const LOAD_TIMEOUT_SEC = Number(process.env.LOAD_TIMEOUT_SEC ?? 1800);
const POLL_MS = 2_000;
const SAMPLE_MS = 5_000;
const PROXY_POD_LABEL = "app.kubernetes.io/name=wardby-coding-proxy";
const RUN_POD_LABEL = "wardby.io/component=coding-run";
// Run.status values (prisma/schema.prisma RunStatus) that will never change again.
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** process.env, with undefined-valued keys dropped (spawn rejects those) and MCP_TRANSPORT forced to stdio. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.MCP_TRANSPORT = "stdio";
  return env;
}

/** Every wardby MCP tool replies with its JSON payload as the first content block's text. */
function parseToolResult(result: CallToolResult, toolName: string): Record<string, unknown> {
  const block = result.content[0];
  const text = block && "text" in block ? block.text : undefined;
  if (typeof text !== "string") {
    throw new Error(`${toolName}: unexpected MCP result shape: ${JSON.stringify(result)}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (result.isError) {
    throw new Error(`${toolName} failed: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed as Record<string, unknown>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- kubectl (execFile, no shell, never secrets in argv) -------------------

const kubectlBase = ["--context", KUBERNETES_CONTEXT, "-n", LOAD_NAMESPACE];

async function kubectl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("kubectl", [...kubectlBase, ...args]);
  return stdout;
}

async function kubectlJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await kubectl(args)) as T;
}

function parseCpuMillicores(v: string): number {
  const m = /^(\d+)m$/.exec(v);
  if (m) return Number(m[1]);
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : NaN;
}

function parseMemMi(v: string): number {
  const gi = /^(\d+)Gi$/.exec(v);
  if (gi) return Number(gi[1]) * 1024;
  const mi = /^(\d+)Mi$/.exec(v);
  if (mi) return Number(mi[1]);
  const ki = /^(\d+)Ki$/.exec(v);
  if (ki) return Number(ki[1]) / 1024;
  const n = Number(v);
  return Number.isFinite(n) ? n / (1024 * 1024) : NaN;
}

interface ProxyPodUsage {
  name: string;
  cpuM: number;
  memMi: number;
}

/** kubectl top pod on the proxy's replicas; [] (with a one-time stderr note) if metrics aren't available yet. */
const warned = new Set<string>();
function warnOnce(key: string, err: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`(sampling) ${key} failed, will keep sampling: ${err instanceof Error ? err.message : String(err)}`);
}

async function topProxyPods(): Promise<ProxyPodUsage[]> {
  const stdout = await kubectl(["top", "pod", "-l", PROXY_POD_LABEL, "--no-headers"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, cpu, mem] = line.split(/\s+/);
      return { name: name!, cpuM: parseCpuMillicores(cpu!), memMi: parseMemMi(mem!) };
    });
}

interface PodListItem {
  status?: { phase?: string };
}

async function runPodPhaseCounts(): Promise<Record<string, number>> {
  const pods = await kubectlJson<{ items: PodListItem[] }>(["get", "pods", "-l", RUN_POD_LABEL, "-o", "json"]);
  const counts: Record<string, number> = {};
  for (const pod of pods.items) {
    const phase = pod.status?.phase ?? "Unknown";
    counts[phase] = (counts[phase] ?? 0) + 1;
  }
  return counts;
}

interface PodCondition {
  type: string;
  status: string;
  lastTransitionTime?: string;
}
interface ContainerStatus {
  state?: { terminated?: { finishedAt?: string } };
}
interface PodDetail {
  status?: { conditions?: PodCondition[]; containerStatuses?: ContainerStatus[] };
}

interface PodTimestamps {
  scheduledAt: string | null;
  readyAt: string | null;
  containersFinishedAt: string | null;
}

/** The run's deterministic pod name/timestamps, or null if the pod is gone (GC'd after finishing). */
async function runPodTimestamps(runId: string): Promise<PodTimestamps | null> {
  const podName = kubernetesRunNames(runId).pod;
  let pod: PodDetail;
  try {
    pod = await kubectlJson<PodDetail>(["get", "pod", podName, "-o", "json"]);
  } catch {
    return null;
  }
  const condition = (type: string) =>
    pod.status?.conditions?.find((c) => c.type === type && c.status === "True")?.lastTransitionTime ?? null;
  const finishedTimes = (pod.status?.containerStatuses ?? [])
    .map((c) => c.state?.terminated?.finishedAt)
    .filter((v): v is string => typeof v === "string")
    .sort();
  return {
    scheduledAt: condition("PodScheduled"),
    readyAt: condition("Ready"),
    containersFinishedAt: finishedTimes.length > 0 ? finishedTimes[finishedTimes.length - 1]! : null,
  };
}

// --- Postgres sampling -------------------------------------------------

interface DbConnectionState {
  state: string | null;
  count: number;
}

async function pgStatActivity(db: PrismaClient): Promise<DbConnectionState[]> {
  const rows = await db.$queryRaw<{ state: string | null; count: bigint }[]>`
    select state, count(*) as count from pg_stat_activity where datname = current_database() group by state
  `;
  return rows.map((r) => ({ state: r.state, count: Number(r.count) }));
}

// Same where clauses drainCodingQueue (src/core/coding-queue.ts) uses to find
// the queue and the active-slot count -- Level A reuses the same pattern.
const QUEUE_WHERE = { queuedAt: { not: null }, jobBackend: null, run: { status: "pending" as RunStatus } };
const ACTIVE_WHERE = {
  jobBackend: { not: null },
  run: { status: { in: ["pending", "running"] as RunStatus[] } },
};

// --- Sampling loop -------------------------------------------------------

interface Sample {
  t: string;
  proxyPods: ProxyPodUsage[];
  podPhases: Record<string, number>;
  dbConnections: DbConnectionState[];
  // null (not 0) when the count query itself failed this tick -- 0 is a
  // real, meaningful sample value and must not be confused with "unknown".
  queueLength: number | null;
  activeSlots: number | null;
}

/** Every probe is individually guarded: a transient kubectl/Postgres failure degrades one field of one sample, never the loop. */
async function takeSample(db: PrismaClient): Promise<Sample> {
  const [proxyPods, podPhases, dbConnections, queueLength, activeSlots] = await Promise.all([
    topProxyPods().catch((err: unknown) => {
      warnOnce("kubectl top pod", err);
      return [];
    }),
    runPodPhaseCounts().catch((err: unknown) => {
      warnOnce("kubectl get pods", err);
      return {};
    }),
    pgStatActivity(db).catch((err: unknown) => {
      warnOnce("pg_stat_activity", err);
      return [];
    }),
    db.codingRun.count({ where: QUEUE_WHERE }).catch((err: unknown) => {
      warnOnce("codingRun.count (queue length)", err);
      return null;
    }),
    db.codingRun.count({ where: ACTIVE_WHERE }).catch((err: unknown) => {
      warnOnce("codingRun.count (active slots)", err);
      return null;
    }),
  ]);
  return { t: new Date().toISOString(), proxyPods, podPhases, dbConnections, queueLength, activeSlots };
}

// --- Trigger + poll --------------------------------------------------------

interface RunRecord {
  index: number;
  runId: string | null;
  dispatchedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  status: string;
  error: string | null;
  everQueued: boolean;
  startedAt: string | null;
  heartbeatAt: string | null;
  pod: PodTimestamps | null;
}

function connectClient(): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(projectRoot, "bin", "wardby.js"), "mcp"],
    cwd: projectRoot,
    env: childEnv(),
    stderr: "inherit",
  });
  const client = new Client(
    { name: "wardby-load-level-b", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  return { client, transport };
}

/**
 * Never throws: a single trigger_agent failure must not discard every other
 * run's already-returned runId (Promise.all would otherwise reject the
 * whole dispatch and the caller loses the (real, now-running) runs that
 * *did* get dispatched). A run whose dispatch itself failed keeps
 * runId === null and status "failed" -- isPollable (below) and the final
 * tally both treat a null runId as accounted-for-and-failed.
 */
async function dispatchRuns(clients: Client[]): Promise<RunRecord[]> {
  const runs: RunRecord[] = Array.from({ length: LOAD_RUNS }, (_, index) => ({
    index,
    runId: null,
    dispatchedAt: new Date().toISOString(),
    claimedAt: null,
    finishedAt: null,
    status: "pending",
    error: null,
    everQueued: false,
    startedAt: null,
    heartbeatAt: null,
    pod: null,
  }));
  await Promise.all(
    runs.map(async (run) => {
      const client = clients[run.index % clients.length]!;
      const dispatchedAt = new Date();
      run.dispatchedAt = dispatchedAt.toISOString();
      try {
        const result = await client.callTool({
          name: "trigger_agent",
          arguments: { agentId: LOAD_AGENT_ID, task: `Load test run ${run.index}.` },
        });
        const parsed = parseToolResult(result, "trigger_agent");
        const runId = (parsed.runId ?? parsed.id) as unknown;
        if (typeof runId !== "string") {
          throw new Error(`trigger_agent did not return a runId for run ${run.index}: ${JSON.stringify(parsed)}`);
        }
        run.runId = runId;
        run.status = typeof parsed.status === "string" ? parsed.status : "pending";
        run.error = typeof parsed.error === "string" ? parsed.error : null;
      } catch (err) {
        run.status = "failed";
        run.error = err instanceof Error ? err.message : String(err);
        console.error(`trigger_agent failed for run ${run.index}: ${run.error}`);
      }
    }),
  );
  return runs;
}

/** A run this many consecutive get_run calls failed for is abandoned by the poll loop (see pollUntilTerminal). */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/**
 * Polls get_run on `client` every POLL_MS for every pollable run (has a
 * runId, not yet terminal, not abandoned) until none are left or
 * LOAD_TIMEOUT_SEC passes. A single get_run failure never aborts the test:
 * failures are counted per run, and a run that fails
 * MAX_CONSECUTIVE_POLL_FAILURES times in a row is abandoned -- excluded
 * from further polling so it can't wedge the loop forever, but not
 * otherwise mislabeled. Its real final status still comes from the
 * authoritative `Run` row read directly from Postgres in main() right
 * after this loop ends, independent of how polling over MCP went, so an
 * abandoned run's eventual outcome is not lost -- only its "claimed" timing
 * precision.
 */
async function pollUntilTerminal(client: Client, runs: RunRecord[]): Promise<{ timedOut: boolean }> {
  const deadline = Date.now() + LOAD_TIMEOUT_SEC * 1000;
  const failures = new Map<number, number>();
  const abandoned = new Set<number>();
  const isPollable = (r: RunRecord): r is RunRecord & { runId: string } =>
    r.runId !== null && !TERMINAL_STATUSES.has(r.status) && !abandoned.has(r.index);
  for (;;) {
    const pending = runs.filter(isPollable);
    if (pending.length === 0) return { timedOut: false };
    if (Date.now() >= deadline) return { timedOut: true };
    await sleep(POLL_MS);
    await Promise.all(
      pending.map(async (run) => {
        try {
          const result = await client.callTool({ name: "get_run", arguments: { runId: run.runId } });
          const parsed = parseToolResult(result, "get_run");
          failures.delete(run.index);
          const status = typeof parsed.status === "string" ? parsed.status : run.status;
          if (run.status === "pending" && status !== "pending" && run.claimedAt === null) {
            run.claimedAt = new Date().toISOString();
          }
          if (typeof parsed.codingQueuedAt === "string") run.everQueued = true;
          run.status = status;
          run.error = typeof parsed.error === "string" ? parsed.error : null;
          run.startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : run.startedAt;
          run.heartbeatAt = typeof parsed.heartbeatAt === "string" ? parsed.heartbeatAt : run.heartbeatAt;
          run.finishedAt = typeof parsed.finishedAt === "string" ? parsed.finishedAt : run.finishedAt;
        } catch (err) {
          const count = (failures.get(run.index) ?? 0) + 1;
          failures.set(run.index, count);
          const message = err instanceof Error ? err.message : String(err);
          if (count >= MAX_CONSECUTIVE_POLL_FAILURES) {
            abandoned.add(run.index);
            console.error(
              `get_run for run ${run.index} (${run.runId}) failed ${count} times in a row; giving up on polling it (the final DB read still picks up its real status). Last error: ${message}`,
            );
          } else {
            console.error(
              `get_run for run ${run.index} (${run.runId}) failed (attempt ${count}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${message}`,
            );
          }
        }
      }),
    );
  }
}

// --- Stats + table ---------------------------------------------------------

interface Stats {
  n: number;
  p50: number;
  p95: number;
}
function stats(samplesMs: number[]): Stats {
  const s = [...samplesMs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { n: s.length, p50: at(0.5) / 1000, p95: at(0.95) / 1000 };
}
const s = (v: number) => v.toFixed(1);

async function main(): Promise<void> {
  const db = createPrismaClient(url);
  const cap = loadCodingConcurrencyConfig().maxConcurrent;
  const children = Array.from({ length: LOAD_CONTROL_PLANES }, connectClient);
  const runs: RunRecord[] = [];
  const samples: Sample[] = [];
  let sampling = false;
  let timedOut = false;
  // Set on any unexpected failure in the core flow below (connect, dispatch,
  // polling, or the final per-run read); the table and LOAD_OUT are still
  // produced from whatever `runs`/`samples` were collected before the
  // failure, and the exit code reflects the incomplete run.
  let incomplete: string | null = null;
  const testStart = performance.now();

  try {
    for (const { client, transport } of children) await client.connect(transport);
    const clients = children.map((c) => c.client);

    console.log(
      `Level B load test -- ${LOAD_RUNS} runs over ${LOAD_CONTROL_PLANES} control planes, cap ${cap}, timeout ${LOAD_TIMEOUT_SEC}s\n`,
    );

    runs.push(...(await dispatchRuns(clients)));

    sampling = true;
    const sampleLoop = (async () => {
      // Never rejects: takeSample already guards every probe it makes, but
      // this catch is the last line of defense -- an unhandled rejection
      // here would otherwise crash the whole process (no finally, no
      // table, no LOAD_OUT) long before the poll loop below ever awaits it.
      while (sampling) {
        try {
          samples.push(await takeSample(db));
        } catch (err) {
          warnOnce("sample loop", err);
        }
        await sleep(SAMPLE_MS);
      }
    })();

    try {
      ({ timedOut } = await pollUntilTerminal(clients[0]!, runs));
    } finally {
      sampling = false;
      await sampleLoop;
    }

    // Final per-run read: Run fields straight from the DB (authoritative,
    // independent of how polling over MCP went -- covers runs the poll
    // loop above abandoned) and the pod's own timestamps, if it still
    // exists. Guarded per run: one DB hiccup must not drop every other
    // run's already-correct data.
    await mapLimit(runs, 8, async (run) => {
      if (!run.runId) return;
      try {
        const row = await db.run.findUnique({
          where: { id: run.runId },
          select: { status: true, error: true, startedAt: true, heartbeatAt: true, finishedAt: true },
        });
        if (row) {
          run.status = row.status;
          run.error = row.error;
          run.startedAt = row.startedAt.toISOString();
          run.heartbeatAt = row.heartbeatAt?.toISOString() ?? null;
          run.finishedAt = row.finishedAt?.toISOString() ?? null;
        }
      } catch (err) {
        warnOnce(`final Run read (run ${run.index})`, err);
      }
      run.pod = await runPodTimestamps(run.runId).catch((err: unknown) => {
        warnOnce("kubectl get pod (per-run)", err);
        return null;
      });
    });
  } catch (err) {
    incomplete = err instanceof Error ? err.message : String(err);
    console.error("Level B load test ended early:", err);
  } finally {
    sampling = false;
    // Close every child's client AND transport, connected or not: a client
    // whose connect() never completed may not hold a transport reference to
    // close through, so closing the transport directly is what actually
    // guarantees the spawned `wardby mcp` process is terminated. allSettled
    // so one rejecting close never skips the rest, or db.$disconnect below.
    await Promise.allSettled(children.flatMap(({ client, transport }) => [client.close(), transport.close()]));
    try {
      await db.$disconnect();
    } catch (err) {
      console.error("db.$disconnect() failed:", err);
    }
  }

  const wallSec = (performance.now() - testStart) / 1000;
  const dispatchToClaimed = stats(
    runs.filter((r) => r.claimedAt).map((r) => Date.parse(r.claimedAt!) - Date.parse(r.dispatchedAt)),
  );
  const claimedToFinished = stats(
    runs.filter((r) => r.claimedAt && r.finishedAt).map((r) => Date.parse(r.finishedAt!) - Date.parse(r.claimedAt!)),
  );
  // A run whose dispatch itself failed (runId still null) never got a real
  // Run row at all -- counted as failed here regardless of its placeholder status.
  const succeeded = runs.filter((r) => r.runId !== null && r.status === "succeeded").length;
  const failedOrLost = runs.filter(
    (r) => r.runId === null || (TERMINAL_STATUSES.has(r.status) && r.status !== "succeeded"),
  ).length;
  const definedOnly = (values: (number | null)[]): number[] => values.filter((v): v is number => v !== null);
  const peakQueued = Math.max(0, ...definedOnly(samples.map((sample) => sample.queueLength)));
  const peakActive = Math.max(0, ...definedOnly(samples.map((sample) => sample.activeSlots)));
  const proxyReplicas = Math.max(0, ...samples.map((sample) => sample.proxyPods.length));
  const peakProxyCpuM = Math.max(0, ...samples.flatMap((sample) => sample.proxyPods.map((p) => p.cpuM)));
  const peakProxyMemMi = Math.max(0, ...samples.flatMap((sample) => sample.proxyPods.map((p) => p.memMi)));
  const peakDbConnections = Math.max(
    0,
    ...samples.map((sample) => sample.dbConnections.reduce((sum, c) => sum + c.count, 0)),
  );

  console.log(
    "| N | control planes | proxy replicas | cap | dispatch→claimed p50/p95 | claimed→finished p50/p95 | total wall s | succeeded | failed/lost | peak queued | peak active | proxy CPU m peak/replica | proxy mem Mi peak | DB connections peak |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  console.log(
    `| ${LOAD_RUNS} | ${LOAD_CONTROL_PLANES} | ${proxyReplicas} | ${cap} | ${s(dispatchToClaimed.p50)}/${s(dispatchToClaimed.p95)} | ${s(claimedToFinished.p50)}/${s(claimedToFinished.p95)} | ${s(wallSec)} | ${succeeded} | ${failedOrLost} | ${peakQueued} | ${peakActive} | ${s(peakProxyCpuM)} | ${s(peakProxyMemMi)} | ${peakDbConnections} |`,
  );
  if (timedOut) console.error(`LOAD_TIMEOUT_SEC (${LOAD_TIMEOUT_SEC}s) passed with runs still non-terminal.`);
  if (incomplete !== null) console.error(`Load test did not complete normally: ${incomplete}`);

  const config = {
    runs: LOAD_RUNS,
    controlPlanes: LOAD_CONTROL_PLANES,
    agentId: LOAD_AGENT_ID,
    namespace: LOAD_NAMESPACE,
    kubernetesContext: KUBERNETES_CONTEXT,
    timeoutSec: LOAD_TIMEOUT_SEC,
    maxConcurrent: cap,
    incomplete: incomplete !== null,
    incompleteReason: incomplete,
  };
  try {
    await writeFile(LOAD_OUT, JSON.stringify({ config, runs, samples }, null, 2));
  } catch (err) {
    console.error(`Failed to write LOAD_OUT (${LOAD_OUT}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const allAccountedFor = runs.length > 0 && runs.every((r) => r.runId !== null && TERMINAL_STATUSES.has(r.status));
  process.exitCode = incomplete === null && allAccountedFor ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
