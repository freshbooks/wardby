import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveQuickstartImages } from "./images.js";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const runtime = `ghcr.io/o/r/wardby-runtime@${digest("a")}`;
const worker = `ghcr.io/o/r/wardby-coding-worker@${digest("b")}`;
const claudeWorker = `ghcr.io/o/r/wardby-claude-coding-worker@${digest("c")}`;
const claudeToolRunner = `ghcr.io/o/r/wardby-claude-tool-runner@${digest("d")}`;

const workerNodePython = `ghcr.io/o/r/wardby-coding-worker-node-python@${digest("e")}`;
const claudeToolRunnerNodePython = `ghcr.io/o/r/wardby-claude-tool-runner-node-python@${digest("f")}`;

function root(): string {
  return mkdtempSync(join(tmpdir(), "wardby-images-"));
}
function writePackageFile(dir: string, body: unknown): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "quickstart-images.json"), typeof body === "string" ? body : JSON.stringify(body));
}
function writeSource(dir: string): void {
  mkdirSync(join(dir, "deploy"), { recursive: true });
  mkdirSync(join(dir, "src", "coding-worker"), { recursive: true });
  writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(dir, "src", "coding-worker", "Dockerfile"), "FROM scratch\n");
}

describe("resolveQuickstartImages", () => {
  it("prefers both environment overrides", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    expect(
      resolveQuickstartImages({
        env: { WARDBY_RUNTIME_IMAGE: "r:1", CODING_WORKER_IMAGE: "w:1" },
        packageRoot: dir,
      }),
    ).toEqual({ runtime: "r:1", worker: "w:1", source: "env" });
  });

  it("ignores blank environment overrides", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    expect(
      resolveQuickstartImages({
        env: {
          WARDBY_RUNTIME_IMAGE: "r:1",
          CODING_WORKER_IMAGE: " ",
          CODING_CLAUDE_WORKER_IMAGE: " ",
          CODING_CLAUDE_TOOL_RUNNER_IMAGE: "t:1",
        },
        packageRoot: dir,
      }),
    ).toEqual({ runtime, worker, source: "package" });
  });

  it("ignores a single environment override", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    expect(resolveQuickstartImages({ env: { WARDBY_RUNTIME_IMAGE: "r:1" }, packageRoot: dir })).toEqual({
      runtime,
      worker,
      source: "package",
    });
  });

  it("uses digest-pinned refs from the package file", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toEqual({ runtime, worker, source: "package" });
  });

  it("returns the Claude Code images from the package file when present", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker, claudeWorker, claudeToolRunner });
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toEqual({
      runtime,
      worker,
      claudeWorker,
      claudeToolRunner,
      source: "package",
    });
  });

  it("stays valid without Claude Code images, leaving Claude Code unavailable", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    const result = resolveQuickstartImages({ env: {}, packageRoot: dir });
    expect(result).not.toHaveProperty("claudeWorker");
    expect(result).not.toHaveProperty("claudeToolRunner");
  });

  it("rejects the whole package file when a Claude Code image is not digest-pinned", () => {
    for (const bad of [
      { claudeWorker: "ghcr.io/o/r/wardby-claude-coding-worker:v1", claudeToolRunner },
      { claudeWorker, claudeToolRunner: "ghcr.io/o/r/wardby-claude-tool-runner:v1" },
      { claudeWorker },
      { claudeWorker: 7, claudeToolRunner },
    ]) {
      const dir = root();
      writePackageFile(dir, { runtime, worker, ...bad });
      expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toHaveProperty("unavailable");
    }
  });

  it("passes Claude Code environment overrides through", () => {
    const dir = root();
    expect(
      resolveQuickstartImages({
        env: {
          WARDBY_RUNTIME_IMAGE: "r:1",
          CODING_WORKER_IMAGE: "w:1",
          CODING_CLAUDE_WORKER_IMAGE: "cw:1",
          CODING_CLAUDE_TOOL_RUNNER_IMAGE: "ct:1",
        },
        packageRoot: dir,
      }),
    ).toEqual({ runtime: "r:1", worker: "w:1", claudeWorker: "cw:1", claudeToolRunner: "ct:1", source: "env" });
  });

  it("uses the Claude env pair over the package pair in package mode", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker, claudeWorker, claudeToolRunner });
    expect(
      resolveQuickstartImages({
        env: { CODING_CLAUDE_WORKER_IMAGE: "cw:1", CODING_CLAUDE_TOOL_RUNNER_IMAGE: "ct:1" },
        packageRoot: dir,
      }),
    ).toEqual({ runtime, worker, claudeWorker: "cw:1", claudeToolRunner: "ct:1", source: "package" });
  });

  it("offers the Claude env pair when the package lacks Claude entries", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker });
    expect(
      resolveQuickstartImages({
        env: { CODING_CLAUDE_WORKER_IMAGE: "cw:1", CODING_CLAUDE_TOOL_RUNNER_IMAGE: "ct:1" },
        packageRoot: dir,
      }),
    ).toMatchObject({ claudeWorker: "cw:1", claudeToolRunner: "ct:1", source: "package" });
  });

  it("never mixes one Claude env image with the package's", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker, claudeWorker, claudeToolRunner });
    expect(resolveQuickstartImages({ env: { CODING_CLAUDE_WORKER_IMAGE: "cw:1" }, packageRoot: dir })).toEqual({
      runtime,
      worker,
      claudeWorker,
      claudeToolRunner,
      source: "package",
    });
    writePackageFile(dir, { runtime, worker });
    const result = resolveQuickstartImages({ env: { CODING_CLAUDE_TOOL_RUNNER_IMAGE: "ct:1" }, packageRoot: dir });
    expect(result).not.toHaveProperty("claudeWorker");
    expect(result).not.toHaveProperty("claudeToolRunner");
  });

  it("never accepts tag-only refs from the package file", () => {
    const dir = root();
    writePackageFile(dir, { runtime: "ghcr.io/o/r/wardby-runtime:v1", worker });
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toHaveProperty("unavailable");
  });

  it("falls through on malformed package files", () => {
    const dir = root();
    writePackageFile(dir, "not json");
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toHaveProperty("unavailable");
  });

  it("builds locally from a source checkout", () => {
    const dir = root();
    writeSource(dir);
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toEqual({
      runtime: "wardby-runtime:local",
      worker: "wardby-coding-worker:local",
      claudeWorker: "wardby-claude-coding-worker:local",
      claudeToolRunner: "wardby-claude-tool-runner:local",
      workerNodePython: "wardby-coding-worker-node-python:local",
      claudeToolRunnerNodePython: "wardby-claude-tool-runner-node-python:local",
      source: "build",
    });
  });

  it("returns the Node + Python images from the package file when present", () => {
    const dir = root();
    writePackageFile(dir, {
      runtime,
      worker,
      claudeWorker,
      claudeToolRunner,
      workerNodePython,
      claudeToolRunnerNodePython,
    });
    expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toEqual({
      runtime,
      worker,
      claudeWorker,
      claudeToolRunner,
      workerNodePython,
      claudeToolRunnerNodePython,
      source: "package",
    });
  });

  it("treats each Node + Python image as optional on its own", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker, workerNodePython });
    const result = resolveQuickstartImages({ env: {}, packageRoot: dir });
    expect(result).toEqual({ runtime, worker, workerNodePython, source: "package" });
    expect(result).not.toHaveProperty("claudeToolRunnerNodePython");
    writePackageFile(dir, { runtime, worker });
    const bare = resolveQuickstartImages({ env: {}, packageRoot: dir });
    expect(bare).not.toHaveProperty("workerNodePython");
    expect(bare).not.toHaveProperty("claudeToolRunnerNodePython");
  });

  it("rejects the whole package file when a Node + Python image is not digest-pinned", () => {
    for (const bad of [
      { workerNodePython: "ghcr.io/o/r/wardby-coding-worker-node-python:v1" },
      { claudeToolRunnerNodePython: "ghcr.io/o/r/wardby-claude-tool-runner-node-python:v1" },
      { workerNodePython: 7 },
      { claudeToolRunnerNodePython: null },
    ]) {
      const dir = root();
      writePackageFile(dir, { runtime, worker, ...bad });
      expect(resolveQuickstartImages({ env: {}, packageRoot: dir })).toHaveProperty("unavailable");
    }
  });

  it("passes Node + Python environment overrides through, in every source", () => {
    const env = {
      CODING_WORKER_IMAGE_NODE_PYTHON_3_12: "wp:1",
      CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12: "ctp:1",
    };
    const dir = root();
    writePackageFile(dir, { runtime, worker, workerNodePython, claudeToolRunnerNodePython });
    expect(resolveQuickstartImages({ env, packageRoot: dir })).toMatchObject({
      workerNodePython: "wp:1",
      claudeToolRunnerNodePython: "ctp:1",
      source: "package",
    });
    expect(
      resolveQuickstartImages({
        env: { ...env, WARDBY_RUNTIME_IMAGE: "r:1", CODING_WORKER_IMAGE: "w:1" },
        packageRoot: dir,
      }),
    ).toEqual({
      runtime: "r:1",
      worker: "w:1",
      workerNodePython: "wp:1",
      claudeToolRunnerNodePython: "ctp:1",
      source: "env",
    });
  });

  it("takes each Node + Python image from the environment independently, ignoring blanks", () => {
    const dir = root();
    writePackageFile(dir, { runtime, worker, workerNodePython, claudeToolRunnerNodePython });
    expect(
      resolveQuickstartImages({
        env: { CODING_WORKER_IMAGE_NODE_PYTHON_3_12: "wp:1", CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12: " " },
        packageRoot: dir,
      }),
    ).toMatchObject({ workerNodePython: "wp:1", claudeToolRunnerNodePython, source: "package" });
  });

  it("reports unavailable otherwise", () => {
    const result = resolveQuickstartImages({ env: {}, packageRoot: root() });
    expect(result).toHaveProperty("unavailable");
    expect((result as { unavailable: string }).unavailable).toMatch(/clone of the wardby repository/);
  });
});
