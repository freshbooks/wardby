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
  queueLength: number;
  activeSlots: number;
}

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
    db.codingRun.count({ where: QUEUE_WHERE }),
    db.codingRun.count({ where: ACTIVE_WHERE }),
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
      const result = await client.callTool({
        name: "trigger_agent",
        arguments: { agentId: LOAD_AGENT_ID, task: `Load test run ${run.index}.` },
      });
      const parsed = parseToolResult(result, "trigger_agent");
      run.dispatchedAt = dispatchedAt.toISOString();
      const runId = (parsed.runId ?? parsed.id) as unknown;
      if (typeof runId !== "string") {
        throw new Error(`trigger_agent did not return a runId for run ${run.index}: ${JSON.stringify(parsed)}`);
      }
      run.runId = runId;
      run.status = typeof parsed.status === "string" ? parsed.status : "pending";
      run.error = typeof parsed.error === "string" ? parsed.error : null;
    }),
  );
  return runs;
}

/** Polls get_run on `client` every POLL_MS until every run is terminal or LOAD_TIMEOUT_SEC passes. */
async function pollUntilTerminal(client: Client, runs: RunRecord[]): Promise<boolean> {
  const deadline = Date.now() + LOAD_TIMEOUT_SEC * 1000;
  for (;;) {
    const pending = runs.filter((r) => !TERMINAL_STATUSES.has(r.status));
    if (pending.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
    await Promise.all(
      pending.map(async (run) => {
        const result = await client.callTool({ name: "get_run", arguments: { runId: run.runId } });
        const parsed = parseToolResult(result, "get_run");
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
  try {
    for (const { client, transport } of children) await client.connect(transport);
    const clients = children.map((c) => c.client);

    console.log(
      `Level B load test -- ${LOAD_RUNS} runs over ${LOAD_CONTROL_PLANES} control planes, cap ${cap}, timeout ${LOAD_TIMEOUT_SEC}s\n`,
    );

    const testStart = performance.now();
    const runs = await dispatchRuns(clients);

    let sampling = true;
    const samples: Sample[] = [];
    const sampleLoop = (async () => {
      while (sampling) {
        samples.push(await takeSample(db));
        await sleep(SAMPLE_MS);
      }
    })();

    const allTerminal = await pollUntilTerminal(clients[0]!, runs);
    sampling = false;
    await sampleLoop;
    const wallSec = (performance.now() - testStart) / 1000;

    // Final per-run read: Run fields straight from the DB (authoritative,
    // post-poll-loop) and the pod's own timestamps, if it still exists.
    await mapLimit(runs, 8, async (run) => {
      if (!run.runId) return;
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
      run.pod = await runPodTimestamps(run.runId).catch((err: unknown) => {
        warnOnce("kubectl get pod (per-run)", err);
        return null;
      });
    });

    const dispatchToClaimed = stats(
      runs.filter((r) => r.claimedAt).map((r) => Date.parse(r.claimedAt!) - Date.parse(r.dispatchedAt)),
    );
    const claimedToFinished = stats(
      runs.filter((r) => r.claimedAt && r.finishedAt).map((r) => Date.parse(r.finishedAt!) - Date.parse(r.claimedAt!)),
    );
    const succeeded = runs.filter((r) => r.status === "succeeded").length;
    const failedOrLost = runs.filter((r) => TERMINAL_STATUSES.has(r.status) && r.status !== "succeeded").length;
    const peakQueued = Math.max(0, ...samples.map((sample) => sample.queueLength));
    const peakActive = Math.max(0, ...samples.map((sample) => sample.activeSlots));
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
    if (!allTerminal) {
      console.error(`LOAD_TIMEOUT_SEC (${LOAD_TIMEOUT_SEC}s) passed with runs still non-terminal.`);
    }

    const config = {
      runs: LOAD_RUNS,
      controlPlanes: LOAD_CONTROL_PLANES,
      agentId: LOAD_AGENT_ID,
      namespace: LOAD_NAMESPACE,
      kubernetesContext: KUBERNETES_CONTEXT,
      timeoutSec: LOAD_TIMEOUT_SEC,
      maxConcurrent: cap,
    };
    await writeFile(LOAD_OUT, JSON.stringify({ config, runs, samples }, null, 2));

    process.exitCode = allTerminal ? 0 : 1;
  } finally {
    await Promise.all(children.map(({ client }) => client.close()));
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
