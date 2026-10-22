#!/usr/bin/env node
import { createServer } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MAX_COMMAND_BYTES,
  MAX_TIMEOUT_MS,
  TOOL_SETUP_ENV,
  commandEnvironment,
  parseToolSetup,
  prepareCommandWorkspace,
  runCommand,
} from "./command.mjs";

const SOCKET_PATH = "/run/wardby/tool/runner.sock";
const WORKSPACE_PATH = "/workspace";
export const TOOL_RUNNER_READY_MESSAGE = "wardby_tool_runner_ready";
/**
 * The worker's one call on a dependency-cache run (claude-coding-worker/driver.ts), before the
 * agent starts. Never the agent's: the worker's SDK options disallow it (sdk.ts), and once any
 * command has run it only answers `already_started`.
 */
export const PREPARE_DEPENDENCIES_TOOL = "wardby_prepare_dependencies";
/**
 * The worker's call once the agent has finished a changes_ready run: puts the original index URLs
 * back in uv.lock and poetry.lock files this tool runner pointed at the proxy (see pypiGate). Never
 * the agent's either (sdk.ts disallows it).
 */
export const RESTORE_PYPI_LOCKFILES_TOOL = "wardby_restore_pypi_lockfiles";

/** The dependency cache module (src/coding-worker/dependency-cache.mjs): the image copies it to
 *  /opt/wardby/coding-worker/, the same path relative to this file as in the repository. */
const loadDefaultDependencyCache = () => import("../coding-worker/dependency-cache.mjs");

/** The uv.lock / poetry.lock session (src/coding/registry/pypi-lockfiles/session.ts, compiled): only the
 *  node-python image copies it to /opt/wardby/coding/registry/, so any other image fails to load it and skips. */
const loadDefaultPypiLockfiles = () => import("../coding/registry/pypi-lockfiles/session.js");

/**
 * The proxy's PyPI route and the run's registry token, read from the pip index the launcher already
 * put in the setup (pypi.ts workerConfig: `http://wardby:<token>@<proxy>/registry/pypi/simple/`).
 * Null without it: the run has no registry, so there is nothing to point a lockfile at.
 */
function pypiRegistry(setup) {
  const raw = setup.env.PIP_INDEX_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const token = decodeURIComponent(url.password);
    if (!token || !url.pathname.endsWith("/simple/")) return null;
    url.username = "";
    url.password = "";
    url.pathname = url.pathname.slice(0, -"simple/".length);
    return { registryUrl: url.toString(), token };
  } catch {
    return null;
  }
}

/**
 * One JSON line on stderr per warning, as for `tool_setup_invalid`: a prepare that left the lockfiles as
 * found (a failed `poetry lock`, say) is otherwise invisible to the person reading the run. The session's
 * warnings name files and reasons, never credentials.
 */
function logPypiWarnings(warnings) {
  for (const message of warnings) process.stderr.write(`${JSON.stringify({ warning: "pypi_lockfiles", message })}\n`);
}

/**
 * Process-wide, across every socket connection: the dependency cache runs at most once, only
 * before the first command, and the first command never starts while it is still running. Before
 * the first command the run's upload window is always sealed (memoized; the proxy's seal is
 * idempotent), whether or not prepare ran, failed or was skipped, so nothing a command (the
 * agent) does can be uploaded as a snapshot. The proxy's upload deadline is the backstop.
 */
function dependencyGate(initialSetup, workspacePath, loadDependencyCache, loadPypiLockfiles) {
  let setup = initialSetup;
  let preparing;
  let sealing;
  let pypi;
  let commandStarted = false;
  const env = () => commandEnvironment(setup, workspacePath);
  /**
   * Once, before the first command (or the dependency cache, whichever comes first): points the
   * workspace's uv.lock and poetry.lock files at the proxy, since the sandbox reaches nothing else, and
   * adds Poetry's source credentials to every later command. Best effort: any failure leaves the files as found.
   */
  const preparePypi = () =>
    (pypi ??= (async () => {
      const registry = pypiRegistry(initialSetup);
      if (!registry) return;
      try {
        await prepareCommandWorkspace(initialSetup, workspacePath);
        const module = await loadPypiLockfiles();
        const result = await module.prepareWorkspacePypiLockfiles({
          workspace: workspacePath,
          ...registry,
          env: commandEnvironment(initialSetup, workspacePath),
        });
        setup = { ...initialSetup, env: { ...initialSetup.env, ...result.env } };
        logPypiWarnings(result.warnings ?? []);
      } catch {
        // The files stay as the repository had them.
        logPypiWarnings(["preparing the workspace failed; files left as found"]);
      }
    })());
  const seal = () =>
    (sealing ??= (async () => {
      try {
        await prepareCommandWorkspace(setup, workspacePath);
        const module = await loadDependencyCache();
        await module.sealUploadWindow({ env: env() });
      } catch {
        // The proxy's upload deadline still closes the window.
      }
    })());
  return {
    /**
     * `deadlineAt`: the run's deadline (ISO), which the worker passes; the cache then takes at most
     * half the time left before it (dependencyCacheTimeLimit), the budget walk included. `signal`:
     * the call's own (aborted when the worker's connection closes): the work stops and settles.
     */
    prepare({ deadlineAt, signal } = {}) {
      if (preparing) return preparing;
      if (commandStarted) return Promise.resolve({ projects: [], reason: "already_started" });
      preparing = (async () => {
        await preparePypi();
        if (deadlineAt !== undefined && !Number.isFinite(Date.parse(deadlineAt)))
          return { projects: [], reason: "invalid_deadline" };
        try {
          const started = Date.now();
          await prepareCommandWorkspace(setup, workspacePath);
          const module = await loadDependencyCache();
          const limitMs = module.dependencyCacheTimeLimit(deadlineAt, started);
          if (limitMs <= 0) return { projects: [], reason: "timeout" };
          // The run's volume (setup.diskMb) minus what the workspace already uses: statfs can't
          // see a Kubernetes emptyDir's sizeLimit. A size it can't measure skips the cache.
          const budget = await module.dependencyCacheBudget({
            workspace: workspacePath,
            diskMb: setup.diskMb,
            signal,
            timeoutMs: Math.min(module.BUDGET_MEASURE_TIMEOUT_MS, limitMs),
          });
          if (budget.reason !== undefined) return { projects: [], reason: budget.reason };
          const totalMs = limitMs - (Date.now() - started);
          if (totalMs <= 0) return { projects: [], reason: "timeout" };
          return await module.prepareDependencies({
            workspace: workspacePath,
            env: env(),
            budgetBytes: budget.budgetBytes,
            usedBytes: budget.usedBytes,
            signal,
            timeouts: { totalMs },
          });
        } catch {
          return { projects: [], reason: "worker_error" };
        }
      })();
      return preparing;
    },
    setup: () => setup,
    /** After the agent: the original URLs back. Never prepares; without a snapshot it changes nothing. */
    async restorePypi() {
      const registry = pypiRegistry(initialSetup);
      if (!registry) return { restored: [], warnings: [] };
      try {
        await pypi;
        const module = await loadPypiLockfiles();
        return await module.restoreWorkspacePypiLockfiles({
          workspace: workspacePath,
          registryUrl: registry.registryUrl,
        });
      } catch {
        return { restored: [], warnings: ["pypi lockfiles: restoring the workspace failed; files left as found"] };
      }
    },
    async beforeCommand() {
      commandStarted = true;
      await preparePypi();
      if (!setup.dependencyCache) return;
      if (preparing) await preparing;
      await seal();
    },
  };
}

function toolServer(setup, gate, workspacePath) {
  const server = new McpServer({ name: "wardby_tools", version: "1.0.0" });
  server.registerTool(
    "run_command",
    {
      description: "Run one bounded shell command in the isolated repository workspace.",
      inputSchema: {
        command: z.string().min(1).max(MAX_COMMAND_BYTES),
        timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
      },
    },
    async ({ command, timeout_ms }) => {
      await gate.beforeCommand();
      const result = await runCommand(command, timeout_ms ?? 60_000, workspacePath, gate.setup());
      return {
        content: [{ type: "text", text: `exit_code=${result.code}\n${result.output}` }],
        isError: result.code !== 0,
      };
    },
  );
  // Only a run with a PyPI registry has lockfiles to put back.
  if (pypiRegistry(setup)) {
    server.registerTool(
      RESTORE_PYPI_LOCKFILES_TOOL,
      {
        description: "Wardby internal: put the original index URLs back in uv and poetry lockfiles.",
        inputSchema: {},
      },
      async () => ({ content: [{ type: "text", text: JSON.stringify(await gate.restorePypi()) }] }),
    );
  }
  if (setup.dependencyCache) {
    server.registerTool(
      PREPARE_DEPENDENCIES_TOOL,
      {
        description: "Wardby internal: restore the run's dependencies before the agent starts.",
        inputSchema: { deadline_at: z.string().max(64).optional() },
      },
      async ({ deadline_at }, extra) => ({
        content: [
          { type: "text", text: JSON.stringify(await gate.prepare({ deadlineAt: deadline_at, signal: extra.signal })) },
        ],
      }),
    );
  }
  return server;
}

export async function startToolRunner(
  socketPath = SOCKET_PATH,
  setup = parseToolSetup(undefined),
  {
    workspacePath = WORKSPACE_PATH,
    loadDependencyCache = loadDefaultDependencyCache,
    loadPypiLockfiles = loadDefaultPypiLockfiles,
  } = {},
) {
  if (!isAbsolute(socketPath)) throw new Error("tool_socket_path_invalid");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const gate = dependencyGate(setup, workspacePath, loadDependencyCache, loadPypiLockfiles);
  const server = createServer((socket) => {
    const mcp = toolServer(setup, gate, workspacePath);
    // A closed connection ends the server, which aborts its in-flight calls' signals (a prepare stops).
    socket.once("close", () => void mcp.close().catch(() => undefined));
    void mcp.connect(new StdioServerTransport(socket, socket)).catch(() => socket.destroy());
  });
  await new Promise((resolve, reject) => server.listen(socketPath, () => resolve()).once("error", reject));
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  let setup;
  try {
    setup = parseToolSetup(process.env[TOOL_SETUP_ENV]);
  } catch {
    process.stderr.write(`${JSON.stringify({ error: "tool_setup_invalid" })}\n`);
    process.exit(1);
  }
  await startToolRunner(SOCKET_PATH, setup);
  process.stdout.write(`${TOOL_RUNNER_READY_MESSAGE}\n`);
}
