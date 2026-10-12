import { createConnection } from "node:net";
import {
  BUDGET_MEASURE_TIMEOUT_MS,
  DEFAULT_TIMEOUTS,
  dependencyCacheTimeLimit,
} from "../coding-worker/dependency-cache.mjs";

/** Where the tool runner listens (claude-tool-runner/main.mjs) and the relay connects (tool-relay.ts). */
export const TOOL_SOCKET_PATH = "/run/wardby/tool/runner.sock";

/**
 * Fails fast, by name, when the tool runner's socket can't be reached, before the model is called.
 * Without it the relay exits, Claude Code runs with no command tool, and the model can only report
 * that it could not run anything: a run that "succeeds" having done nothing. (Under gVisor, for one,
 * a socket bound on a volume the two containers don't share is simply absent from this side.)
 */
export async function assertToolRunnerReachable(socketPath = TOOL_SOCKET_PATH, timeoutMs = 5_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const fail = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("worker_tool_runner_unreachable"));
    };
    const timer = setTimeout(fail, timeoutMs);
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
  });
}

/** The tool runner's internal tool (claude-tool-runner/main.mjs); the agent's SDK options disallow it (sdk.ts). */
export const PREPARE_DEPENDENCIES_TOOL = "wardby_prepare_dependencies";
/** Room for the tool runner and the socket on top of the module's own bounds. */
const PREPARE_DEPENDENCIES_MARGIN_MS = 60_000;
/**
 * Derived from the dependency cache's own bounds (dependency-cache.mjs, the same file the tool runner
 * runs): the budget walk, then the whole prepare (totalMs) and its settle grace, plus a margin. A
 * worker that stops waiting earlier is still safe: the tool runner holds the first command until
 * the cache has finished, and seals before it.
 */
export const PREPARE_DEPENDENCIES_TIMEOUT_MS =
  BUDGET_MEASURE_TIMEOUT_MS + DEFAULT_TIMEOUTS.totalMs + DEFAULT_TIMEOUTS.settleMs + PREPARE_DEPENDENCIES_MARGIN_MS;
const MAX_RESPONSE_LINE_BYTES = 256 * 1024;

export interface PrepareDependenciesCall {
  socketPath?: string;
  /** Defaults to the cache's bound for `deadlineAt` (dependencyCacheTimeLimit) plus its settle grace and a margin. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The run's deadline (CodingTaskInput.deadlineAt), passed to the tool: the cache takes at most half the time left. */
  deadlineAt?: string;
}

/** How long the worker waits for the prepare tool on a run with this deadline. */
export function prepareDependenciesTimeoutMs(deadlineAt?: string, now = Date.now()): number {
  if (deadlineAt === undefined) return PREPARE_DEPENDENCIES_TIMEOUT_MS;
  return Math.min(
    PREPARE_DEPENDENCIES_TIMEOUT_MS,
    dependencyCacheTimeLimit(deadlineAt, now) + DEFAULT_TIMEOUTS.settleMs + PREPARE_DEPENDENCIES_MARGIN_MS,
  );
}

/**
 * The worker's one call to the tool runner on a dependency-cache run, before the agent starts: a
 * minimal MCP client (newline-delimited JSON-RPC, as the relay carries) that initializes and calls
 * PREPARE_DEPENDENCIES_TOOL once. Resolves with the tool's JSON (unchecked: the caller bounds it).
 * Fails only with `dependency_cache_tool_unavailable` (a tool runner without the tool) or
 * `dependency_cache_tool_failed`; never with the tool runner's text.
 */
export async function callPrepareDependencies({
  socketPath = TOOL_SOCKET_PATH,
  deadlineAt,
  timeoutMs = prepareDependenciesTimeoutMs(deadlineAt),
  signal,
}: PrepareDependenciesCall = {}): Promise<unknown> {
  const failed = () => new Error("dependency_cache_tool_failed");
  if (signal?.aborted) throw failed();
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  const pending = new Map<number, { resolve: (message: JsonRpcResponse) => void }>();
  let buffered = "";
  let settle: ((error: Error) => void) | undefined;
  const broken = new Promise<never>((_, reject) => {
    settle = reject;
  });
  // Every waiter races `broken`; keep an unobserved rejection from surfacing.
  broken.catch(() => undefined);
  const fail = (error: Error) => settle?.(error);
  const timer = setTimeout(() => fail(failed()), timeoutMs);
  const onAbort = () => fail(failed());
  signal?.addEventListener("abort", onAbort, { once: true });
  socket.on("error", () => fail(failed()));
  socket.once("close", () => fail(failed()));
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        fail(failed());
        return;
      }
      if (typeof message?.id === "number") pending.get(message.id)?.resolve(message);
    }
    if (Buffer.byteLength(buffered) > MAX_RESPONSE_LINE_BYTES) fail(failed());
  });
  let nextId = 0;
  const request = (method: string, params: unknown): Promise<JsonRpcResponse> => {
    const id = ++nextId;
    const answered = new Promise<JsonRpcResponse>((resolve) => pending.set(id, { resolve }));
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return Promise.race([answered, broken]);
  };
  try {
    await Promise.race([new Promise<void>((resolve) => socket.once("connect", () => resolve())), broken]);
    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "wardby-claude-worker", version: "1.0.0" },
    });
    if (!initialized.result) throw failed();
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const called = await request("tools/call", {
      name: PREPARE_DEPENDENCIES_TOOL,
      arguments: deadlineAt === undefined ? {} : { deadline_at: deadlineAt },
    });
    const result = called.result as
      { isError?: boolean; content?: Array<{ type?: string; text?: unknown }> } | undefined;
    if (called.error || !result || result.isError) throw new Error("dependency_cache_tool_unavailable");
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (typeof text !== "string") throw failed();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw failed();
    }
  } catch (error) {
    if (error instanceof Error && error.message === "dependency_cache_tool_unavailable") throw error;
    throw failed();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    socket.destroy();
  }
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}
