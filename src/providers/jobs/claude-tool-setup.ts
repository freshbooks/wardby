/**
 * What Claude Code's tool runner (the credential-free container that runs commands in the
 * repository) needs from the trusted launcher: the package-registry settings every Codex shell
 * gets, built from the run's registry-only token (deriveRegistryToken, never the capability), and
 * the run's service test variables. Delivered as CLAUDE_TOOL_SETUP_ENV: a Kubernetes Secret key, or
 * `docker create --env NAME` with the value in the CLI's own environment.
 */
import { serviceEnvironment } from "../../coding-worker/driver.js";
import { registryWorkerSetup } from "../../coding/registry/worker-config.js";
import { CODING_PROXY_ALIAS, CODING_PROXY_PORT } from "./docker-isolation.js";
import type { JobSpec } from "./types.js";

/** Where the tool runner mounts the repository; the registry's config files live under its .cache. */
const TOOL_WORKSPACE = "/workspace";

export interface ClaudeToolSetup {
  schemaVersion: 1;
  env: Record<string, string>;
  files: { path: string; content: string; mode: number }[];
}

export function claudeToolSetup(spec: JobSpec, capability: string): string {
  if (spec.provider !== "claude-code") throw new Error("claude_tool_setup_provider");
  const registry = registryWorkerSetup({
    proxyBaseUrl: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
    capability,
    cacheRoot: `${TOOL_WORKSPACE}/.cache`,
  });
  const setup: ClaudeToolSetup = {
    schemaVersion: 1,
    // Same precedence as the Codex driver: the registry's own settings win over a service's.
    env: { ...serviceEnvironment(spec.services), ...registry.env },
    files: registry.files,
  };
  return JSON.stringify(setup);
}
