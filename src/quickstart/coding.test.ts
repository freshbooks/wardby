import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codingEnvUpdates,
  codingStep,
  defaultTrustedFolder,
  quickstartComposeFiles,
  type CodingDeps,
  type CommandResult,
} from "./coding.js";
import type { CodingSeedInput } from "./coding-seed.js";
import { quickstartPaths, readQuickstartEnv, writeQuickstartEnv, type QuickstartState } from "./config.js";

const RUNTIME = `ghcr.io/wardby/wardby-runtime@sha256:${"1".repeat(64)}`;
const WORKER = `ghcr.io/wardby/wardby-coding-worker@sha256:${"2".repeat(64)}`;
const BUILT_ID = `sha256:${"3".repeat(64)}`;

let scratch: string;
let repoA: string;
let folderB: string;
let projectDir: string;
let packageRoot: string;

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "pipe",
    encoding: "utf8",
  });

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "init");
}

function commitServices(dir: string, text: string): void {
  mkdirSync(join(dir, ".wardby"), { recursive: true });
  writeFileSync(join(dir, ".wardby", "services.yaml"), text);
  gitIn(dir, "add", ".wardby/services.yaml");
  gitIn(dir, "commit", "-q", "-m", "services");
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "quickstart-coding-")));
  repoA = join(scratch, "repo-a");
  folderB = join(scratch, "folder-b");
  projectDir = join(scratch, "project");
  packageRoot = join(scratch, "package");
  makeRepo(repoA);
  mkdirSync(folderB);
  mkdirSync(projectDir);
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(
    join(packageRoot, "dist", "quickstart-images.json"),
    JSON.stringify({ runtime: RUNTIME, worker: WORKER }),
  );
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const state: QuickstartState = {
  version: 1,
  projectDir: "",
  composeProject: "wardby-test-abc",
  postgresPort: 55432,
  provider: "openai",
  model: "gpt-5.6-luna",
  packageVersion: "0.0.0",
  createdAt: "2026-10-07T00:00:00.000Z",
};

function harness(overrides: Partial<CodingDeps> = {}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const seeds: Array<Omit<CodingSeedInput, "ownerId">> = [];
  const pulledServiceImages: string[][] = [];
  const run = (command: string, args: string[]): CommandResult => {
    calls.push([command, ...args]);
    if (args[0] === "image" && args[1] === "inspect" && args.includes("--format")) {
      return { status: 0, stdout: `${BUILT_ID}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const deps: CodingDeps = {
    run,
    prompts: {
      line: async () => {
        throw new Error("no prompts in non-interactive tests");
      },
      yesNo: async () => {
        throw new Error("no prompts in non-interactive tests");
      },
      secret: async () => {
        throw new Error("no prompts in non-interactive tests");
      },
    },
    log: (line) => logs.push(line),
    cwd: repoA,
    env: {},
    packageRoot,
    seed: async (input) => {
      seeds.push(input);
      return { builder: { id: "b1", status: "created" }, reviewer: { id: "r1", status: "created" } };
    },
    catalogImages: async (services) => {
      pulledServiceImages.push(services.map((service) => `${service.name}:${service.version}`));
      return services.map((service) => ({
        service,
        image: `docker.io/library/${service.name}@sha256:${"9".repeat(64)}`,
      }));
    },
    ...overrides,
  };
  return { deps, calls, logs, seeds, pulledServiceImages };
}

function paths() {
  return quickstartPaths(projectDir);
}

describe("defaultTrustedFolder", () => {
  it("is the top level of the git work tree containing cwd", () => {
    mkdirSync(join(repoA, "nested", "deeper"), { recursive: true });
    expect(defaultTrustedFolder(join(repoA, "nested", "deeper"))).toBe(repoA);
  });

  it("is null outside a git work tree", () => {
    expect(defaultTrustedFolder(folderB)).toBeNull();
  });
});

describe("codingEnvUpdates", () => {
  it("joins roots with the platform path delimiter and selects the docker launcher", () => {
    const updates = codingEnvUpdates({
      roots: ["/a", "/b"],
      provider: "codex",
      workerImage: WORKER,
      runtimeImage: RUNTIME,
    });
    expect(updates).toEqual({
      LOCAL_REPO_ROOTS: `/a${delimiter}/b`,
      JOB_LAUNCHER: "docker",
      CODING_WORKER_IMAGE: WORKER,
      WARDBY_RUNTIME_IMAGE: RUNTIME,
      CODING_PROXY_CONTAINER: "wardby-coding-proxy",
    });
  });

  it("adds the Claude Code images only for claude-code", () => {
    const updates = codingEnvUpdates({
      roots: ["/a"],
      provider: "claude-code",
      workerImage: WORKER,
      runtimeImage: RUNTIME,
      claudeWorkerImage: "sha256:c",
      claudeToolRunnerImage: "sha256:t",
    });
    expect(updates.CODING_CLAUDE_WORKER_IMAGE).toBe("sha256:c");
    expect(updates.CODING_CLAUDE_TOOL_RUNNER_IMAGE).toBe("sha256:t");
  });
});

describe("codingStep (non-interactive)", () => {
  it("--no-coding leaves the env untouched and runs nothing", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const before = readFileSync(paths().envFile, "utf8");
    const { deps, calls, seeds } = harness();
    const result = await codingStep(paths(), state, { nonInteractive: true, coding: false, trust: [repoA] }, deps);
    expect(result).toBeNull();
    expect(readFileSync(paths().envFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
    expect(seeds).toEqual([]);
  });

  it("is skipped without --coding when non-interactive", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const before = readFileSync(paths().envFile, "utf8");
    const { deps, calls } = harness();
    expect(await codingStep(paths(), state, { nonInteractive: true, trust: [] }, deps)).toBeNull();
    expect(readFileSync(paths().envFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
  });

  it("--coding --trust A --trust B writes the env, starts the proxy, and seeds both agents", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test", DATABASE_URL: "postgresql://x" });
    const { deps, calls, seeds } = harness();
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA, folderB] },
      deps,
    );

    const env = readQuickstartEnv(paths());
    expect(env).toMatchObject({
      OPENAI_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://x",
      LOCAL_REPO_ROOTS: `${repoA}${delimiter}${folderB}`,
      JOB_LAUNCHER: "docker",
      CODING_WORKER_IMAGE: WORKER,
      WARDBY_RUNTIME_IMAGE: RUNTIME,
      CODING_PROXY_CONTAINER: "wardby-coding-proxy",
    });

    expect(calls).toContainEqual(["docker", "pull", RUNTIME]);
    expect(calls).toContainEqual(["docker", "pull", WORKER]);
    const up = calls.find((call) => call.includes("up"))!;
    expect(up).toEqual(expect.arrayContaining(["compose", "--project-name", "wardby-test-abc", "coding-proxy"]));
    expect(up.filter((arg) => arg.endsWith("docker-compose.quickstart-coding.yml"))).toHaveLength(1);
    // The in-process preflight inspected the worker image.
    expect(calls).toContainEqual(["docker", "image", "inspect", WORKER]);

    expect(seeds).toEqual([
      {
        provider: "codex",
        builderModel: "gpt-5.6-luna",
        reviewerModel: "gpt-5.6-luna",
        repository: `local:${repoA}`,
        baseRef: "main",
        services: [],
      },
    ]);
    expect(result).toMatchObject({ roots: [repoA, folderB], repository: `local:${repoA}`, provider: "codex" });
    // Nothing was written into the repository without --starter-services.
    expect(gitIn(repoA, "branch", "--list", "wardby/*").trim()).toBe("");
  });

  it("keeps roots from an earlier run and adds new ones", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test", LOCAL_REPO_ROOTS: repoA });
    const { deps } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [folderB] }, deps);
    expect(readQuickstartEnv(paths()).LOCAL_REPO_ROOTS).toBe(`${repoA}${delimiter}${folderB}`);
  });

  it("needs --trust when no folder is trusted yet", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const before = readFileSync(paths().envFile, "utf8");
    const { deps, logs, calls } = harness();
    expect(await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [] }, deps)).toBeNull();
    expect(logs.join("\n")).toMatch(/--trust/);
    expect(readFileSync(paths().envFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
  });

  it("refuses a --trust folder that does not exist", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, logs } = harness();
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [join(scratch, "missing")] },
      deps,
    );
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/does not exist/);
  });

  it("skips when the chosen provider has no key", async () => {
    writeQuickstartEnv(paths(), {});
    const { deps, logs, calls } = harness();
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "codex" },
      deps,
    );
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/OPENAI_API_KEY/);
    expect(calls).toEqual([]);
  });

  it("builds the images from a source checkout and pins the worker by its local image id", async () => {
    rmSync(join(packageRoot, "dist", "quickstart-images.json"));
    mkdirSync(join(packageRoot, "deploy"));
    writeFileSync(join(packageRoot, "deploy", "Dockerfile"), "FROM scratch\n");
    mkdirSync(join(packageRoot, "src", "coding-worker"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "coding-worker", "Dockerfile"), "FROM scratch\n");
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, calls } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);

    const builds = calls.filter((call) => call[1] === "build");
    expect(builds).toHaveLength(2);
    expect(builds[0]).toEqual(
      expect.arrayContaining(["--file", join(packageRoot, "deploy", "Dockerfile"), "--target", "runtime"]),
    );
    expect(builds[0]).toEqual(expect.arrayContaining(["--tag", "wardby-runtime:local", packageRoot]));
    expect(builds[1]).toEqual(expect.arrayContaining(["--tag", "wardby-coding-worker:local", packageRoot]));
    expect(calls.some((call) => call[1] === "pull")).toBe(false);
    const env = readQuickstartEnv(paths());
    expect(env.WARDBY_RUNTIME_IMAGE).toBe("wardby-runtime:local");
    expect(env.CODING_WORKER_IMAGE).toBe(BUILT_ID);
  });

  it("skips Claude Code when its images are not available", async () => {
    writeQuickstartEnv(paths(), { ANTHROPIC_API_KEY: "sk-ant" });
    const before = readFileSync(paths().envFile, "utf8");
    const { deps, logs, seeds } = harness();
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/Claude Code/);
    expect(readFileSync(paths().envFile, "utf8")).toBe(before);
    expect(seeds).toEqual([]);
  });

  it("lists a committed services.yaml, pre-pulls its images, and allows those services", async () => {
    commitServices(repoA, 'services:\n  postgres: "16"\n  redis: "7"\n');
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, calls, logs, seeds, pulledServiceImages } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);
    expect(pulledServiceImages).toEqual([["postgres:16", "redis:7"]]);
    expect(calls).toContainEqual(["docker", "pull", `docker.io/library/postgres@sha256:${"9".repeat(64)}`]);
    expect(logs.join("\n")).toMatch(/postgres 16, redis 7/);
    expect(seeds[0].services).toEqual(["postgres", "redis"]);
  });

  it("continues past a service image that cannot be pulled", async () => {
    commitServices(repoA, 'services:\n  postgres: "16"\n');
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const base = harness();
    const run = (command: string, args: string[]): CommandResult =>
      args[0] === "pull" && args[1].includes("postgres")
        ? { status: 1, stdout: "", stderr: "denied" }
        : base.deps.run(command, args);
    const { deps, logs, seeds } = harness({ run });
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);
    expect(logs.join("\n")).toMatch(/could not pull/i);
    expect(seeds).toHaveLength(1);
  });

  it("prints the validation error for an invalid services.yaml and continues", async () => {
    commitServices(repoA, "databases:\n  postgres: 16\n");
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, logs, seeds } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);
    expect(logs.join("\n")).toMatch(/only top-level key allowed is `services`/);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].services).toEqual([]);
  });

  it("--starter-services commits a starter file onto its own branch without touching the work tree", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    writeFileSync(join(repoA, "README.md"), "dirty\n");
    const status = gitIn(repoA, "--no-optional-locks", "status", "--porcelain");
    const { deps, logs, seeds } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], starterServices: ["postgres", "redis"] },
      deps,
    );
    expect(gitIn(repoA, "show", "wardby/quickstart-services:.wardby/services.yaml")).toMatch(
      /services:\n {2}postgres: "16"\n {2}redis: "7"\n$/,
    );
    expect(gitIn(repoA, "--no-optional-locks", "status", "--porcelain")).toBe(status);
    expect(gitIn(repoA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(logs.join("\n")).toMatch(/wardby\/quickstart-services/);
    expect(logs.join("\n")).toMatch(/baseRef/);
    expect(seeds[0].services).toEqual(["postgres", "redis"]);
  });

  it("does not replace an existing starter branch non-interactively", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    gitIn(repoA, "branch", "wardby/quickstart-services");
    const before = gitIn(repoA, "rev-parse", "wardby/quickstart-services");
    const { deps, logs } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], starterServices: ["redis"] },
      deps,
    );
    expect(gitIn(repoA, "rev-parse", "wardby/quickstart-services")).toBe(before);
    expect(logs.join("\n")).toMatch(/already exists/);
  });

  it("seeds against the first trusted folder that is a repository", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, seeds } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [folderB, repoA] }, deps);
    expect(seeds[0].repository).toBe(`local:${repoA}`);
  });
});

describe("codingStep (interactive)", () => {
  it("asks, trusts the current repository, and offers a starter file", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const questions: string[] = [];
    const answers = new Map<RegExp, string | boolean>([
      [/Set up coding/, true],
      [/Trust/, true],
      [/Add another/, ""],
      [/services\.yaml/, "p"],
    ]);
    const answer = (question: string) => {
      questions.push(question);
      for (const [pattern, value] of answers) if (pattern.test(question)) return value;
      throw new Error(`unexpected question: ${question}`);
    };
    const { deps, seeds } = harness({
      prompts: {
        line: async (question) => answer(question) as string,
        yesNo: async (question) => answer(question) as boolean,
        secret: async () => "unused",
      },
    });
    const result = await codingStep(paths(), state, { nonInteractive: false, trust: [] }, deps);
    expect(result?.roots).toEqual([repoA]);
    expect(seeds[0].services).toEqual(["postgres"]);
    expect(gitIn(repoA, "show", "wardby/quickstart-services:.wardby/services.yaml")).toMatch(/postgres: "16"/);
    expect(questions.some((question) => /Set up coding \+ review agents/.test(question))).toBe(true);
  });
});

describe("quickstart compose files", () => {
  it("adds the coding proxy file only once its runtime image is configured", () => {
    expect(quickstartComposeFiles("/pkg", {})).toEqual(["/pkg/deploy/local/docker-compose.yml"]);
    expect(quickstartComposeFiles("/pkg", { WARDBY_RUNTIME_IMAGE: RUNTIME })).toEqual([
      "/pkg/deploy/local/docker-compose.yml",
      "/pkg/deploy/local/docker-compose.quickstart-coding.yml",
    ]);
  });

  it("gives the proxy the same database credentials as the quickstart postgres service", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const coding = readFileSync(join(repoRoot, "deploy/local/docker-compose.quickstart-coding.yml"), "utf8");
    const base = readFileSync(join(repoRoot, "deploy/local/docker-compose.yml"), "utf8");
    expect(coding).toContain(
      "DATABASE_URL: postgresql://${WARDBY_POSTGRES_USER:-wardby}:${WARDBY_POSTGRES_PASSWORD:-wardby}@postgres:5432/${WARDBY_POSTGRES_DB:-wardby}",
    );
    for (const variable of [
      "${WARDBY_POSTGRES_USER:-wardby}",
      "${WARDBY_POSTGRES_PASSWORD:-wardby}",
      "${WARDBY_POSTGRES_DB:-wardby}",
    ]) {
      expect(base).toContain(variable);
    }
  });
});
