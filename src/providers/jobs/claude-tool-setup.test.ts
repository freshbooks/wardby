import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import { registryWorkerSetup } from "../../coding/registry/worker-config.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition } from "../../coding/services/catalog.js";
import { claudeToolSetup } from "./claude-tool-setup.js";
import { CLAUDE_TOOL_SETUP_ENV } from "./docker-isolation.js";
import type { JobSpec } from "./types.js";

const CAPABILITY = `rrp_${"c".repeat(32)}`;
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-claude-setup",
  provider: "claude-code",
  image: `registry.example/wardby-claude-coding-worker@sha256:${"a".repeat(64)}`,
  toolImage: `registry.example/wardby-claude-tool-runner@sha256:${"b".repeat(64)}`,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};
const POSTGRES = resolvedFromDefinition(
  BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!,
);

describe("claudeToolSetup", () => {
  it("names its environment variable", () => {
    expect(CLAUDE_TOOL_SETUP_ENV).toBe("WARDBY_TOOL_SETUP");
  });

  it("hands the tool runner the registry settings a Codex shell gets, under /workspace/.cache", () => {
    const expected = registryWorkerSetup({
      proxyBaseUrl: "http://wardby-proxy:8787",
      capability: CAPABILITY,
      cacheRoot: "/workspace/.cache",
    });
    expect(JSON.parse(claudeToolSetup(spec, CAPABILITY))).toEqual({
      schemaVersion: 1,
      env: expected.env,
      files: expected.files,
    });
  });

  it("carries the registry-only token and never the capability", () => {
    const raw = claudeToolSetup(spec, CAPABILITY);
    expect(raw).not.toContain(CAPABILITY);
    expect(raw).toContain(deriveRegistryToken(CAPABILITY));
  });

  it("adds each service's test variables", () => {
    const setup = JSON.parse(claudeToolSetup({ ...spec, services: [POSTGRES] }, CAPABILITY));
    expect(setup.env).toMatchObject(POSTGRES.testEnv);
  });

  it("refuses a Codex spec", () => {
    expect(() => claudeToolSetup({ ...spec, provider: "codex", toolImage: undefined }, CAPABILITY)).toThrow(
      "claude_tool_setup_provider",
    );
  });
});
