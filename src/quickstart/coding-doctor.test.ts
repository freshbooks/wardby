import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codingDoctorLines, type CodingDoctorDeps, type LocalAgent } from "./coding-doctor.js";

const WORKER = `sha256:${"a".repeat(64)}`;
let scratch: string;
let repo: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "coding-doctor-")));
  repo = join(scratch, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function deps(agents: LocalAgent[], running = true): CodingDoctorDeps {
  return {
    run: (_command, args) => {
      if (args[0] === "inspect") return { status: running ? 0 : 1, stdout: running ? "true\n" : "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    listLocalAgents: async () => agents,
  };
}

describe("codingDoctorLines", () => {
  it("is empty when the coding step was never configured", async () => {
    expect(await codingDoctorLines({}, deps([]))).toEqual([]);
  });

  it("reports roots, the worker image, the proxy, and each local agent's repository and services", async () => {
    mkdirSync(join(repo, ".wardby"));
    writeFileSync(join(repo, ".wardby", "services.yaml"), 'services:\n  postgres: "16"\n');
    git("add", ".");
    git("commit", "-q", "-m", "services");
    const env = {
      LOCAL_REPO_ROOTS: `${scratch}${delimiter}${join(scratch, "gone")}`,
      JOB_LAUNCHER: "docker",
      CODING_WORKER_IMAGE: WORKER,
    };
    const lines = await codingDoctorLines(
      env,
      deps([
        { name: "local-builder", repository: `local:${repo}`, ref: "main" },
        { name: "local-reviewer", repository: `local:${repo}` },
        { name: "elsewhere", repository: "local:/not/trusted" },
      ]),
    );
    expect(lines).toEqual([
      `✓ Trusted folder ${scratch}`,
      `✗ Trusted folder ${join(scratch, "gone")} (does not exist)`,
      "✓ Coding worker image",
      "✓ Coding proxy container (wardby-coding-proxy)",
      `✓ local-builder: ${repo} is inside the trusted folders`,
      "✓ local-builder: .wardby/services.yaml on main declares postgres 16",
      `✓ local-reviewer: ${repo} is inside the trusted folders`,
      "✓ local-reviewer: .wardby/services.yaml on main declares postgres 16",
      "✗ elsewhere: local_repo_not_allowed: repository is outside the configured local roots",
    ]);
  });

  it("shows the builder's toolchain", async () => {
    const env = { LOCAL_REPO_ROOTS: scratch, JOB_LAUNCHER: "docker", CODING_WORKER_IMAGE: WORKER };
    const lines = await codingDoctorLines(
      env,
      deps([
        {
          name: "local-builder",
          repository: `local:${repo}`,
          ref: "main",
          toolchain: "node-python",
          toolchainVersion: "3.12",
        },
        { name: "plain", repository: `local:${repo}`, ref: "main", toolchain: "node", toolchainVersion: null },
      ]),
    );
    expect(lines).toContain("✓ local-builder: toolchain node-python 3.12");
    expect(lines).toContain("✓ plain: toolchain node");
  });

  it("reports a missing or invalid services.yaml and a stopped proxy", async () => {
    const env = { LOCAL_REPO_ROOTS: scratch, JOB_LAUNCHER: "docker", CODING_WORKER_IMAGE: "worker:latest" };
    const lines = await codingDoctorLines(env, deps([{ name: "b", repository: `local:${repo}` }], false));
    expect(lines).toContain("✗ Coding worker image (CODING_WORKER_IMAGE must be an immutable digest or image id)");
    expect(lines).toContain("✗ Coding proxy container (wardby-coding-proxy) (not running)");
    expect(lines).toContain("✓ b: no .wardby/services.yaml on main (no services)");

    mkdirSync(join(repo, ".wardby"));
    writeFileSync(join(repo, ".wardby", "services.yaml"), "nope: 1\n");
    git("add", ".");
    git("commit", "-q", "-m", "bad");
    const again = await codingDoctorLines(env, deps([{ name: "b", repository: `local:${repo}` }]));
    expect(again.find((line) => line.startsWith("✗ b: .wardby/services.yaml"))).toMatch(/only top-level key/);
  });

  it("checks the Claude Code images on a Claude-only setup without asking for CODING_WORKER_IMAGE", async () => {
    const env = {
      LOCAL_REPO_ROOTS: scratch,
      JOB_LAUNCHER: "docker",
      CODING_CLAUDE_WORKER_IMAGE: WORKER,
      CODING_CLAUDE_TOOL_RUNNER_IMAGE: "tools:latest",
    };
    const lines = await codingDoctorLines(env, deps([]));
    expect(lines.some((line) => line.includes("CODING_WORKER_IMAGE"))).toBe(false);
    expect(lines).toContain("✓ Claude Code worker image");
    expect(lines).toContain(
      "✗ Claude Code tool runner image (CODING_CLAUDE_TOOL_RUNNER_IMAGE must be an immutable digest or image id)",
    );
  });

  it("names both options when no worker image is configured", async () => {
    const lines = await codingDoctorLines({ LOCAL_REPO_ROOTS: scratch, JOB_LAUNCHER: "docker" }, deps([]));
    expect(lines).toContain(
      "✗ Coding worker image (set CODING_WORKER_IMAGE for Codex, or CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE for Claude Code)",
    );
  });

  it("treats a blank CODING_WORKER_IMAGE as unset next to the Claude Code images", async () => {
    const env = {
      LOCAL_REPO_ROOTS: scratch,
      JOB_LAUNCHER: "docker",
      CODING_WORKER_IMAGE: "  ",
      CODING_CLAUDE_WORKER_IMAGE: WORKER,
      CODING_CLAUDE_TOOL_RUNNER_IMAGE: WORKER,
    };
    const lines = await codingDoctorLines(env, deps([]));
    expect(lines.some((line) => line.includes("CODING_WORKER_IMAGE"))).toBe(false);
    expect(lines).toContain("✓ Claude Code worker image");
  });
});
