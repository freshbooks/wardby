import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import { registryWorkerSetup } from "../../coding/registry/worker-config.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { MAX_AGENT_SERVICES, MAX_SERVICE_ENV, resolvedFromDefinition } from "../../coding/services/catalog.js";
import {
  MAX_ENV_ENTRIES,
  MAX_ENV_VALUE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_SETUP_BYTES,
  parseToolSetup,
} from "../../claude-tool-runner/command.mjs";
import { CLAUDE_TOOL_SETUP_LIMITS, claudeToolSetup } from "./claude-tool-setup.js";
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

  it("builds within exactly the limits the tool runner enforces", () => {
    expect(CLAUDE_TOOL_SETUP_LIMITS).toEqual({
      maxEnvEntries: MAX_ENV_ENTRIES,
      maxEnvValueBytes: MAX_ENV_VALUE_BYTES,
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxSetupBytes: MAX_SETUP_BYTES,
    });
  });

  it("leaves room for every variable of the most services a run can carry", () => {
    const registry = registryWorkerSetup({
      proxyBaseUrl: "http://wardby-proxy:8787",
      capability: CAPABILITY,
      cacheRoot: "/workspace/.cache",
    });
    expect(MAX_ENV_ENTRIES).toBeGreaterThanOrEqual(
      MAX_AGENT_SERVICES * MAX_SERVICE_ENV + Object.keys(registry.env).length,
    );
    const services = Array.from({ length: MAX_AGENT_SERVICES }, (_, index) => ({
      ...POSTGRES,
      name: `svc-${index}`,
      testEnv: Object.fromEntries(
        Array.from({ length: MAX_SERVICE_ENV }, (_, variable) => [`S${index}_V${variable}`, "x"]),
      ),
    }));
    const raw = claudeToolSetup({ ...spec, services }, CAPABILITY);
    expect(Object.keys(parseToolSetup(raw).env)).toHaveLength(
      MAX_AGENT_SERVICES * MAX_SERVICE_ENV + Object.keys(registry.env).length,
    );
  });

  it("refuses to build a setup the tool runner would reject, rather than launching a runner that never gets ready", () => {
    const oversized = (testEnv: Record<string, string>) => ({
      ...spec,
      services: [{ ...POSTGRES, testEnv }],
    });
    // Too many bytes in total: the setup travels as one environment variable.
    const bulky = Object.fromEntries(
      Array.from({ length: Math.ceil(MAX_SETUP_BYTES / 1000) + 1 }, (_, index) => [`BULK_${index}`, "x".repeat(1000)]),
    );
    expect(() => claudeToolSetup(oversized(bulky), CAPABILITY)).toThrow("claude_tool_setup_too_large");
    // One value over the per-value cap.
    expect(() => claudeToolSetup(oversized({ BIG: "x".repeat(MAX_ENV_VALUE_BYTES + 1) }), CAPABILITY)).toThrow(
      "claude_tool_setup_too_large",
    );
    // Too many entries.
    const many = Object.fromEntries(Array.from({ length: MAX_ENV_ENTRIES + 1 }, (_, index) => [`V${index}`, "x"]));
    expect(() => claudeToolSetup(oversized(many), CAPABILITY)).toThrow("claude_tool_setup_too_large");
  });
});
