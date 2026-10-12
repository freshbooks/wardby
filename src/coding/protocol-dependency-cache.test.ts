import { describe, expect, it } from "vitest";
import {
  CodingTaskInputSchema,
  CODING_PROTOCOL_VERSION,
  CodingAgentOutputSchema,
  dependencyCacheTaskNote,
  MAX_DEPENDENCY_CACHE_PROJECTS,
  parseCodingAgentOutputJson,
  parseCodingWorkerOutputJson,
  restoredDependencyFolders,
  sanitizeDependencyCacheReport,
} from "./protocol.js";

const output = {
  schemaVersion: CODING_PROTOCOL_VERSION,
  runId: "run_123",
  outcome: "changes_ready",
  summary: "Fixed the test.",
  tests: [{ command: "npm test", outcome: "passed" }],
};

describe("worker output: dependencyCache", () => {
  it("still parses a worker output without it (older workers, runs with the cache off)", () => {
    const parsed = parseCodingWorkerOutputJson(JSON.stringify(output));
    expect(parsed.dependencyCache).toBeUndefined();
    expect("dependencyCache" in parsed).toBe(false);
  });

  it("carries a bounded report from the worker", () => {
    const report = {
      projects: [
        { path: ".", result: "hit", key: "abc123", sizeBytes: 1024, restoreMs: 40, rebuild: "skipped" },
        { path: "web/client", result: "cold", reason: "inconsistent", installMs: 9000, rebuild: "unsealed" },
      ],
    };
    const parsed = parseCodingWorkerOutputJson(JSON.stringify({ ...output, dependencyCache: report }));
    expect(parsed.dependencyCache).toEqual(report);
  });

  it("never lets the model write it: the agent's own output schema refuses the key", () => {
    expect(() =>
      parseCodingAgentOutputJson(JSON.stringify({ ...output, dependencyCache: { projects: [] } })),
    ).toThrow();
    expect(() => CodingAgentOutputSchema.parse({ ...output, dependencyCache: { projects: [] } })).toThrow();
  });

  it("replaces a malformed report with a stable code instead of failing the run", () => {
    const parsed = parseCodingWorkerOutputJson(
      JSON.stringify({ ...output, dependencyCache: { projects: [{ path: "../x", result: "pwned" }], extra: 1 } }),
    );
    expect(parsed.dependencyCache).toEqual({ projects: [], reason: "report_invalid" });
  });
});

describe("sanitizeDependencyCacheReport", () => {
  it("keeps only stable codes and bounded numbers", () => {
    expect(
      sanitizeDependencyCacheReport({
        projects: [
          { path: ".", result: "refused", reason: "Some raw npm output\nwith lines" },
          { path: "app", result: "hit", sizeBytes: -1 },
          { path: "has space", result: "hit" },
          { path: "ok", result: "skipped", reason: "no_lockfile", extra: "x" },
        ],
      }),
    ).toEqual({ projects: [], omitted: 4 });
  });

  it("caps at the project limit, keeping restored projects ahead of skipped ones, in order", () => {
    const projects = [
      { path: ".", result: "skipped", reason: "workspaces" },
      { path: "a", result: "hit" },
      { path: "a/b", result: "skipped", reason: "workspace_member" },
      { path: "c", result: "nearest" },
      { path: "d", result: "cold" },
      { path: "e", result: "refused", reason: "unsafe_archive" },
      { path: "f", result: "skipped", reason: "too_many_projects" },
    ];
    const report = sanitizeDependencyCacheReport({ projects });
    expect(report.projects.map((project) => project.path)).toEqual(["a", "c", "d", "e"]);
    expect(report.projects).toHaveLength(MAX_DEPENDENCY_CACHE_PROJECTS);
    expect(report.omitted).toBe(3);
  });

  it("keeps a planning failure's top-level reason", () => {
    expect(sanitizeDependencyCacheReport({ projects: [], reason: "timeout" })).toEqual({
      projects: [],
      reason: "timeout",
    });
  });

  it("anything that is not a report is report_invalid", () => {
    for (const value of [undefined, null, "x", 1, [], { projects: "x" }]) {
      expect(sanitizeDependencyCacheReport(value)).toEqual({ projects: [], reason: "report_invalid" });
    }
  });
});

describe("dependencyCacheTaskNote", () => {
  it("names the installed folders, the root as the repo root", () => {
    expect(
      dependencyCacheTaskNote({
        projects: [
          { path: ".", result: "hit" },
          { path: "web", result: "cold", reason: "inconsistent" },
          { path: "api", result: "refused", reason: "unsafe_archive" },
          { path: "docs", result: "nearest" },
        ],
      }),
    ).toBe(
      "Dependencies are pre-installed from the committed lockfile in: the repo root, web, docs. Don't run `npm ci` there; add packages with a single install command.",
    );
  });

  it("is absent when nothing was installed", () => {
    expect(dependencyCacheTaskNote(undefined)).toBeUndefined();
    expect(dependencyCacheTaskNote({ projects: [], reason: "worker_error" })).toBeUndefined();
    expect(
      dependencyCacheTaskNote({
        projects: [
          { path: ".", result: "skipped", reason: "no_lockfile" },
          { path: "x", result: "refused", reason: "unsafe_archive" },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("restoredDependencyFolders", () => {
  it("lists only hit and nearest projects", () => {
    expect(
      restoredDependencyFolders({
        projects: [
          { path: ".", result: "hit" },
          { path: "a", result: "cold" },
          { path: "b", result: "nearest" },
        ],
      }),
    ).toEqual([".", "b"]);
    expect(restoredDependencyFolders(undefined)).toEqual([]);
  });
});

describe("worker input: diskMb", () => {
  const input = {
    schemaVersion: CODING_PROTOCOL_VERSION,
    runId: "run_123",
    repository: "openai/example",
    baseRef: "main",
    headRef: "wardby/run-run_123",
    task: "Fix it.",
    model: "gpt-5.6-luna",
    budgetUsd: 1,
    deadlineAt: "2026-09-07T13:00:00.000Z",
  };

  it("carries the volume size with the dependency cache, within the launchers' bounds", () => {
    expect(CodingTaskInputSchema.parse({ ...input, dependencyCache: true, diskMb: 2048 }).diskMb).toBe(2048);
    for (const diskMb of [63, 32_769, 1.5, "2048"]) {
      expect(() => CodingTaskInputSchema.parse({ ...input, dependencyCache: true, diskMb })).toThrow();
    }
  });

  it("refuses it without the dependency cache, and an input without either is unchanged", () => {
    expect(() => CodingTaskInputSchema.parse({ ...input, diskMb: 2048 })).toThrow();
    expect(CodingTaskInputSchema.parse(input)).not.toHaveProperty("diskMb");
  });
});
