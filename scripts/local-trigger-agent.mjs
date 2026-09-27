#!/usr/bin/env node
/**
 * Triggers a coding agent's run locally over MCP, the way a real MCP client
 * (Claude Code, Claude Desktop, ...) would, without needing one installed.
 * `wardby run` (the CLI) refuses coding agents on purpose -- MCP's
 * trigger_agent is the only way to start one -- so exercising a coding run
 * against the kind harness (deploy/kind-coding/) needs a client. This script
 * spawns `wardby mcp` as a stdio subprocess, lists agents, triggers the one
 * asked for (optionally overriding its task), and polls get_run until the
 * run reaches a terminal status, printing status/error/cost/PR url.
 *
 * Usage:
 *   node scripts/local-trigger-agent.mjs --list
 *   node scripts/local-trigger-agent.mjs <agentId> ["task text override"]
 *
 * Prerequisites: `npm run build` (this runs the built bin/wardby.js, not
 * source directly) and a working MCP stdio principal (LOCAL_PRINCIPAL /
 * .wardby auth) -- see deploy/kind-coding/README.md's "Run a real coding
 * agent locally" section for the full list (migrations applied,
 * JOB_LAUNCHER=kubernetes, the worker image env vars).
 *
 * MCP_TRANSPORT is always forced to "stdio" for the spawned process, even if
 * .env.local sets MCP_TRANSPORT=http for the long-running server: the two
 * are independent processes, and dotenv-flow never overwrites a variable
 * already present in the child's environment (src/env.ts), so setting it
 * here is enough regardless of what .env.local says.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const POLL_MS = 5_000;
// Run.status values (prisma/schema.prisma RunStatus) that will never change again.
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);

/** Every wardby MCP tool replies with its JSON payload as the first content block's text. */
function parseToolResult(result, toolName) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`${toolName}: unexpected MCP result shape: ${JSON.stringify(result)}`);
  }
  const parsed = JSON.parse(text);
  if (result.isError) {
    throw new Error(`${toolName} failed: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** process.env, with undefined-valued keys dropped (spawn rejects those) and MCP_TRANSPORT forced. */
function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.MCP_TRANSPORT = "stdio";
  return env;
}

async function main() {
  const args = process.argv.slice(2);
  const wantsList = args.length === 0 || args[0] === "--list" || args[0] === "-l";
  const agentId = wantsList ? undefined : args[0];
  const taskOverride = wantsList ? undefined : args[1];

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "bin", "wardby.js"), "mcp"],
    cwd: projectRoot,
    env: childEnv(),
    // The default is already "inherit", but this is the one property that
    // matters for debugging a failed run, so it's spelled out here rather
    // than left implicit: a launch or config error from `wardby mcp` prints
    // to this process's own stderr instead of vanishing into the transport.
    stderr: "inherit",
  });
  const client = new Client(
    { name: "wardby-local-trigger-agent", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);

  try {
    const agentsResult = await client.callTool({ name: "list_agents", arguments: {} });
    const agents = parseToolResult(agentsResult, "list_agents");
    const codingAgents = agents.filter((agent) => agent.kind === "coding");

    if (wantsList) {
      if (codingAgents.length === 0) {
        console.log("No coding agents visible to this MCP principal (LOCAL_PRINCIPAL).");
      } else {
        for (const agent of codingAgents) console.log(`${agent.id}\t${agent.name}`);
      }
      return;
    }

    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found or not visible to this MCP principal.`);
    if (agent.kind !== "coding") {
      throw new Error(`Agent "${agentId}" is kind=${agent.kind}, not a coding agent.`);
    }

    console.error(`Triggering agent ${agent.id} (${agent.name})...`);
    const triggerResult = await client.callTool({
      name: "trigger_agent",
      arguments: taskOverride === undefined ? { agentId: agent.id } : { agentId: agent.id, task: taskOverride },
    });
    const triggered = parseToolResult(triggerResult, "trigger_agent");
    if (triggered.status === "refused") {
      console.error(`Run refused: ${triggered.error ?? "no reason given"}`);
      process.exitCode = 1;
      return;
    }
    const runId = triggered.runId ?? triggered.id;
    if (typeof runId !== "string") {
      throw new Error(`trigger_agent did not return a runId: ${JSON.stringify(triggered)}`);
    }
    console.error(`Run ${runId} dispatched. Polling get_run every ${POLL_MS / 1000}s...`);
    console.error(
      "(the canary pod you may see first is preflight, worker-only; a real run's pod carries both " +
        "a keeper and a worker container)",
    );

    for (;;) {
      const runResult = await client.callTool({ name: "get_run", arguments: { runId } });
      const run = parseToolResult(runResult, "get_run");
      console.error(`  status=${run.status}`);
      if (TERMINAL_STATUSES.has(run.status)) {
        console.log(
          JSON.stringify(
            {
              runId: run.id,
              status: run.status,
              error: run.error ?? null,
              costUsd: run.costUsd ?? null,
              pullRequestUrl: run.codingResult?.pullRequestUrl ?? null,
              failureCategory: run.failureCategory ?? null,
              diagnosticId: run.diagnosticId ?? null,
            },
            null,
            2,
          ),
        );
        process.exitCode = run.status === "succeeded" ? 0 : 1;
        return;
      }
      await sleep(POLL_MS);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
