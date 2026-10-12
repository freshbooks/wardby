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

/** The dependency cache module (src/coding-worker/dependency-cache.mjs): the image copies it to
 *  /opt/wardby/coding-worker/, the same path relative to this file as in the repository. */
const loadDefaultDependencyCache = () => import("../coding-worker/dependency-cache.mjs");

/**
 * Process-wide, across every socket connection: the dependency cache runs at most once, only
 * before the first command, and the first command never starts while it is still running.
 * When it never ran, the first command seals the run's upload window first, so nothing a command
 * (the agent) does can be uploaded as a snapshot. The proxy's upload deadline is the backstop.
 */
function dependencyGate(setup, workspacePath, loadDependencyCache) {
  let preparing;
  let sealing;
  let commandStarted = false;
  const env = () => commandEnvironment(setup, workspacePath);
  return {
    prepare() {
      if (preparing) return preparing;
      if (commandStarted) return Promise.resolve({ projects: [], reason: "already_started" });
      preparing = (async () => {
        try {
          await prepareCommandWorkspace(setup, workspacePath);
          const module = await loadDependencyCache();
          return await module.prepareDependencies({ workspace: workspacePath, env: env() });
        } catch {
          return { projects: [], reason: "worker_error" };
        }
      })();
      return preparing;
    },
    async beforeCommand() {
      commandStarted = true;
      if (!setup.dependencyCache) return;
      if (preparing) {
        // It seals on its own before it returns.
        await preparing;
        return;
      }
      sealing ??= (async () => {
        try {
          await prepareCommandWorkspace(setup, workspacePath);
          const module = await loadDependencyCache();
          await module.sealUploadWindow({ env: env() });
        } catch {
          // The proxy's upload deadline still closes the window.
        }
      })();
      await sealing;
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
      const result = await runCommand(command, timeout_ms ?? 60_000, workspacePath, setup);
      return {
        content: [{ type: "text", text: `exit_code=${result.code}\n${result.output}` }],
        isError: result.code !== 0,
      };
    },
  );
  if (setup.dependencyCache) {
    server.registerTool(
      PREPARE_DEPENDENCIES_TOOL,
      { description: "Wardby internal: restore the run's dependencies before the agent starts.", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: JSON.stringify(await gate.prepare()) }] }),
    );
  }
  return server;
}

export async function startToolRunner(
  socketPath = SOCKET_PATH,
  setup = parseToolSetup(undefined),
  { workspacePath = WORKSPACE_PATH, loadDependencyCache = loadDefaultDependencyCache } = {},
) {
  if (!isAbsolute(socketPath)) throw new Error("tool_socket_path_invalid");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const gate = dependencyGate(setup, workspacePath, loadDependencyCache);
  const server = createServer((socket) => {
    const mcp = toolServer(setup, gate, workspacePath);
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
