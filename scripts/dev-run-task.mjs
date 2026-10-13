#!/usr/bin/env node
/**
 * Local-dev "run a task" action, driven by the Tilt button on the `wardby` resource (never used in
 * production). Creates a fresh native agent from the button's inputs, then runs it once and streams
 * the output to the Tilt log. A new agent per task keeps reruns simple; the viewer shows each run.
 *
 * Inputs arrive as environment variables:
 *   TASK_PROMPT   required, what the agent should do
 *   TASK_MODEL    a model id from the shipped catalog (default gpt-4o-mini)
 *   TASK_BUDGET   hard USD cap for the agent's runs (default 0.10, at most MAX_BUDGET_USD)
 *   TASK_NAME     optional name prefix (default "task"); a timestamp keeps it unique
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MAX_BUDGET_USD = 5;

/** Parses the button's budget field (empty means 0.10); throws if it is not a positive amount within the ceiling. */
export function parseBudget(raw) {
  const budget = Number((raw ?? "").trim() || "0.10");
  if (!Number.isFinite(budget) || budget <= 0)
    throw new Error(`budget must be a positive number of USD, got "${raw}".`);
  if (budget > MAX_BUDGET_USD)
    throw new Error(`budget ${budget} is above the ${MAX_BUDGET_USD} USD dev ceiling; lower it.`);
  return budget;
}

function fail(message) {
  console.error(`dev-run-task: ${message}`);
  process.exit(1);
}

function main() {
  const prompt = (process.env.TASK_PROMPT ?? "").trim();
  if (!prompt) fail("TASK_PROMPT is empty; type the task in the button's Task field.");

  const model = (process.env.TASK_MODEL ?? "").trim() || "gpt-4o-mini";
  let budget;
  try {
    budget = parseBudget(process.env.TASK_BUDGET);
  } catch (error) {
    fail(error.message);
  }

  const prefix = ((process.env.TASK_NAME ?? "").trim() || "task").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const name = `${prefix}-${stamp}`;

  /** Runs `wardby <args>` through the CLI, which loads .env/.env.local itself, streaming its output. */
  function cli(args) {
    const result = spawnSync(
      join(root, "node_modules", ".bin", "tsx"),
      ["--conditions=wardby-source", "src/cli.ts", ...args],
      {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      },
    );
    if (result.status !== 0) fail(`wardby ${args.slice(0, 2).join(" ")} failed (exit ${result.status}).`);
  }

  console.log(`Creating agent "${name}" (${model}, budget $${budget.toFixed(2)})...`);
  cli(["agent", "create", "--name", name, "--model", model, "--prompt", prompt, "--budget", String(budget)]);
  console.log(`\nRunning "${name}"...\n`);
  cli(["run", name]);
  console.log(`\nDone. See the run in the viewer, or: npm run cli -- runs --agent ${name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
