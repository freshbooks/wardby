/**
 * End to end, against real PostgreSQL: a fix round that changes no code but rewrites the pull
 * request description, from the review that asked for it to the PR being marked ready.
 *
 *   draft PR -> review CHANGES_REQUESTED (description lacks `Resolves #12`) -> fix round whose
 *   coding run ends no_changes with a final message that adds it -> description PATCHed (new
 *   text, refreshed sections, latest-run marker) -> one no-change re-review -> it approves ->
 *   markReadyWhenPassing marks the PR ready.
 *
 * Everything between the database and GitHub's HTTP API is the production code: the
 * orchestration (startReviewFixAfterReview, reReviewAfterNoChangeFix, markReadyAfterRun), the
 * ContainerExecutor with the Prisma store, the real VCS stack the composition builds
 * (RoutingVcsProvider -> GitVcsProvider -> GitHubRemote -> GitHubAppClient), and the
 * GitHubReviewHost over the same App client. Only the edges are fakes: GitHub's HTTP API (an
 * in-memory fake behind `fetch`), the git subprocess (GitHubRemote only allows https, so no
 * local bare repository can stand in), the job launcher, the model proxy sessions, and the
 * native executor (whose runs, the fix agent and the reviewer, are played by this test).
 *
 * The coding run's provisioning claim and job handle are kept in memory rather than written:
 * a row holding a job handle counts as a taken coding slot, which other database test files
 * running in parallel would see (see coding-concurrency.database.test.ts).
 *
 * Skipped without DATABASE_URL.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "#prisma";
import type { CodingProvider } from "../coding/provider.js";
import type { Executor } from "../providers/executor/types.js";
import {
  ContainerExecutor,
  PrismaContainerExecutionStore,
  RunCapabilityVault,
  type CodingSessionController,
  type ProvisioningClaim,
} from "../providers/executor/container.js";
import type { JobHandle, JobResult, JobStatus, WorkspaceJobLauncher } from "../providers/jobs/types.js";
import { GitHubReviewHost } from "../providers/review-host/github.js";
import type { GitCommandOptions, GitCommandResult, GitCommandRunner } from "../providers/vcs/git.js";
import { GitHubAppClient, GitHubRemote, GitVcsProvider, RoutingVcsProvider } from "../providers/vcs/index.js";
import { pullRequestBody } from "../providers/vcs/github.js";
import { descriptionSha256 } from "../providers/vcs/pr-description.js";
import { createPrismaClient } from "./db.js";
import { markReadyAfterRun } from "./mark-ready.js";
import type { RepoAccessGate } from "./repo-access.js";
import { reReviewAfterNoChangeFix, startReviewFixAfterReview } from "./review-fix.js";

const TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz-1234567890.example";
const APP_ID = 99;
const APP_SLUG = "wardby-test";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const IMAGE = `registry.example/worker@sha256:${"a".repeat(64)}`;
const CHECK_NAME = "wardby review";

const OLD_SUMMARY =
  "Adds the knock-knock joke endpoint with a seeded list of jokes, and a handler test covering the happy path.";
const NEW_SUMMARY = `${OLD_SUMMARY}\n\nResolves #12`;
const REVIEW_BODY =
  "MUST_FIX: the pull request description does not link its issue. Add `Resolves #12` so merging closes it.";

type Json = Record<string, unknown>;

interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  external_id?: string;
  app: { id: number };
  output?: unknown;
}

/** GitHub's REST/GraphQL API for one repository and one draft pull request, in memory. */
class FakeGitHub {
  readonly requests: string[] = [];
  readonly descriptionPatches: string[] = [];
  readonly markReadyMutations: Json[] = [];
  readonly comments: Array<{ id: number; body: string; user: { type: string; login: string } }> = [];
  readonly checkRuns: CheckRun[] = [];
  private nextId = 1000;
  readonly pr: Json;

  constructor(
    private readonly repository: string,
    readonly prNumber: number,
    headRef: string,
    body: string,
  ) {
    this.pr = {
      number: prNumber,
      html_url: `https://github.com/${repository}/pull/${prNumber}`,
      node_id: `PR_node_${prNumber}`,
      state: "open",
      draft: true,
      merged: false,
      body,
      labels: [] as Array<{ name: string }>,
      user: { type: "Bot", login: `${APP_SLUG}[bot]` },
      head: { sha: HEAD_SHA, ref: headRef, repo: { full_name: repository } },
      base: { ref: "main" },
    };
  }

  get body(): string {
    return this.pr.body as string;
  }

  get labels(): string[] {
    return (this.pr.labels as Array<{ name: string }>).map((label) => label.name);
  }

  readonly fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const sent = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Json) : {};
    const path = url.pathname;
    this.requests.push(`${method} ${path}`);
    const repo = `/repos/${this.repository}`;
    const pr = `${repo}/pulls/${this.prNumber}`;
    const issue = `${repo}/issues/${this.prNumber}`;

    if (method === "GET" && path === "/app") return json({ id: APP_ID, slug: APP_SLUG, owner: { login: "acme" } });
    if (method === "GET" && path === `${repo}/installation`) return json({ id: 42 });
    if (method === "POST" && path === "/app/installations/42/access_tokens") {
      return json(
        {
          token: TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: sent.permissions,
          repositories: [{ full_name: this.repository }],
        },
        201,
      );
    }
    if (method === "DELETE" && path === "/installation/token") return new Response(null, { status: 204 });

    if (method === "GET" && path === `${repo}/pulls`) {
      const open =
        this.pr.state === "open" &&
        url.searchParams.get("head") === `${this.repository.split("/")[0]}:${(this.pr.head as Json).ref as string}`;
      return json(open ? [this.pr] : []);
    }
    if (method === "GET" && path === pr) return json(this.pr);
    if (method === "PATCH" && path === pr) {
      if (typeof sent.body === "string") {
        this.descriptionPatches.push(sent.body);
        this.pr.body = sent.body;
      }
      return json(this.pr);
    }

    if (method === "GET" && path === `${issue}/comments`) return json(this.comments);
    if (method === "POST" && path === `${issue}/comments`) {
      const comment = { id: this.nextId++, body: String(sent.body), user: { type: "Bot", login: `${APP_SLUG}[bot]` } };
      this.comments.push(comment);
      return json(
        { ...comment, html_url: `https://github.com/${this.repository}/pull/${this.prNumber}#c${comment.id}` },
        201,
      );
    }
    const commentPatch = new RegExp(`^${repo}/issues/comments/(\\d+)$`).exec(path);
    if (method === "PATCH" && commentPatch) {
      const comment = this.comments.find((c) => c.id === Number(commentPatch[1]));
      if (comment) comment.body = String(sent.body);
      return json(comment ?? {});
    }
    if (method === "POST" && path === `${issue}/labels`) {
      for (const name of sent.labels as string[]) {
        if (!this.labels.includes(name)) (this.pr.labels as Array<{ name: string }>).push({ name });
      }
      return json(this.pr.labels);
    }

    const commitChecks = new RegExp(`^${repo}/commits/([0-9a-f]{40})/check-runs$`).exec(path);
    if (method === "GET" && commitChecks) {
      const name = url.searchParams.get("check_name");
      const runs = this.checkRuns.filter((r) => r.head_sha === commitChecks[1] && (!name || r.name === name));
      return json({ total_count: runs.length, check_runs: runs });
    }
    if (method === "GET" && new RegExp(`^${repo}/commits/[0-9a-f]{40}/status$`).test(path)) {
      return json({ statuses: [] });
    }
    if (method === "POST" && path === `${repo}/check-runs`) {
      const run: CheckRun = {
        id: this.nextId++,
        name: String(sent.name),
        head_sha: String(sent.head_sha),
        status: typeof sent.status === "string" ? sent.status : "queued",
        conclusion: typeof sent.conclusion === "string" ? sent.conclusion : null,
        ...(typeof sent.external_id === "string" ? { external_id: sent.external_id } : {}),
        app: { id: APP_ID },
        output: sent.output,
      };
      this.checkRuns.push(run);
      return json(run, 201);
    }
    const checkPatch = new RegExp(`^${repo}/check-runs/(\\d+)$`).exec(path);
    if (method === "PATCH" && checkPatch) {
      const run = this.checkRuns.find((r) => r.id === Number(checkPatch[1]));
      if (!run) return json({ message: "Not Found" }, 404);
      Object.assign(run, {
        ...(typeof sent.status === "string" ? { status: sent.status } : {}),
        ...(typeof sent.conclusion === "string" ? { conclusion: sent.conclusion } : {}),
        ...(sent.output ? { output: sent.output } : {}),
      });
      return json(run);
    }

    if (method === "POST" && path === "/graphql") {
      const query = String(sent.query);
      if (query.includes("markPullRequestReadyForReview")) {
        this.markReadyMutations.push(sent.variables as Json);
        if ((sent.variables as Json).id === this.pr.node_id) this.pr.draft = false;
        return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
    }
    return json({ message: `unexpected ${method} ${path}` }, 404);
  }) as typeof fetch;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/**
 * The git subprocess, scripted: a clone lays out the workspace and separate metadata directory
 * GitVcsProvider expects, and every revision resolves to the PR's head (a no-change round).
 */
class ScriptedGit implements GitCommandRunner {
  constructor(
    private readonly remoteUrl: string,
    private readonly headRef: string,
  ) {}

  async run(args: readonly string[], _options?: GitCommandOptions): Promise<GitCommandResult> {
    const command = args.find((value) =>
      ["clone", "config", "branch", "symbolic-ref", "read-tree", "remote", "rev-parse", "ls-remote"].includes(value),
    );
    if (command === "clone") {
      const metadataPath = args[args.indexOf("--separate-git-dir") + 1];
      const workspacePath = args.at(-1)!;
      await mkdir(metadataPath, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(resolve(workspacePath, ".git"), `gitdir: ${metadataPath}\n`);
      await writeFile(
        resolve(metadataPath, "config"),
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "\tbare = false",
          `\tworktree = ${workspacePath}`,
          '[remote "origin"]',
          `\turl = ${this.remoteUrl}`,
        ].join("\n"),
      );
      await writeFile(resolve(workspacePath, "README.md"), "jokes\n");
    }
    if (command === "remote")
      return { stdout: args.includes("get-url") ? `${this.remoteUrl}\n` : "origin\n", stderr: "" };
    if (command === "rev-parse") return { stdout: `${HEAD_SHA}\n`, stderr: "" };
    if (command === "symbolic-ref" && args.includes("--short")) return { stdout: `${this.headRef}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  }
}

/** The worker: launched, finished at once, and its result is the no-change round's final message. */
class FinishedJobs implements WorkspaceJobLauncher {
  readonly handle: JobHandle = { backend: "fake", id: "job-fix-round" };
  constructor(private readonly result: () => JobResult) {}
  supportsServicesFor(_provider: CodingProvider): boolean {
    return false;
  }
  async launch(): Promise<JobHandle> {
    return this.handle;
  }
  async status(): Promise<JobStatus> {
    return { state: "succeeded" };
  }
  async collect(): Promise<JobResult> {
    return this.result();
  }
  async stop(): Promise<void> {}
  async remove(): Promise<void> {}
  async materializeWorkspace(): Promise<void> {}
}

const sessions: CodingSessionController = {
  createSession: async () => ({ id: "session-fix-round", capability: `rrp_${"x".repeat(32)}` }),
  cancelSession: async () => {},
  budgetExhausted: async () => false,
  upstreamFailure: async () => null,
};

/** The Prisma store, with the slot claim and job handle kept in memory (see the file comment). */
class InMemorySlotStore extends PrismaContainerExecutionStore {
  constructor(private readonly prisma: PrismaClient) {
    super(prisma);
  }
  override async claimProvisioning(runId: string): Promise<ProvisioningClaim> {
    await this.prisma.run.update({ where: { id: runId }, data: { status: "running" } });
    return "claimed";
  }
  override async persistHandle(): Promise<void> {}
}

describe.skipIf(!process.env.DATABASE_URL)(
  "fix round that only rewrites the PR description (database, end to end)",
  () => {
    const db = createPrismaClient();
    const suffix = randomUUID();
    const s8 = suffix.slice(0, 8);
    const id = (name: string) => `fixdesc-${name}-${suffix}`;
    const owner = id("owner");
    const delivery = id("delivery");
    const coder = id("coder");
    const reviewer = id("reviewer");
    const repository = `acme/fixdesc-${s8}`;
    const rootRunId = id("root");
    const headRef = `wardby/run-${rootRunId}`;
    const workRoots: string[] = [];

    beforeAll(async () => {
      await db.principal.create({ data: { id: owner, subject: owner } });
      for (const [agentId, kind] of [
        [delivery, "native"],
        [coder, "coding"],
        [reviewer, "native"],
      ] as const) {
        await db.agent.create({
          data: {
            id: agentId,
            name: agentId,
            systemPrompt: "x",
            model: "gpt-5.6-luna",
            budgetUsd: 5,
            kind,
            ownerId: owner,
          },
        });
      }
      await db.agentRepository.create({
        data: {
          agentId: delivery,
          provider: "github",
          repository,
          access: "write",
          triggers: ["mention", "review_fix"],
          markReadyWhenPassing: true,
          authorizedVia: "host_permission",
        },
      });
      await db.agentRepository.create({
        data: {
          agentId: reviewer,
          provider: "github",
          repository,
          access: "write",
          triggers: ["pull_request"],
          checkName: CHECK_NAME,
          authorizedVia: "host_permission",
        },
      });
    });

    afterAll(async () => {
      await db.codingRun.deleteMany({ where: { run: { agentId: { in: [delivery, coder, reviewer] } } } });
      await db.run.deleteMany({ where: { agentId: { in: [delivery, coder, reviewer] } } });
      await db.agent.deleteMany({ where: { id: { in: [delivery, coder, reviewer] } } });
      await db.principal.deleteMany({ where: { id: owner } });
      await db.$disconnect();
      await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })));
    });

    it("review asks for `Resolves #N` -> no-change fix round rewrites the description -> re-review approves -> marked ready", async () => {
      // --- The draft PR wardby opened: its root coding run recorded the description's hash. ---
      const originalBody = pullRequestBody({
        repository,
        baseRef: "main",
        headRef,
        runId: rootRunId,
        summary: OLD_SUMMARY,
        tests: [{ command: "npm test", outcome: "passed" }],
      });
      const github = new FakeGitHub(repository, 7, headRef, originalBody);
      const openerRun = id("opener");
      await db.run.create({ data: { id: openerRun, agentId: delivery, status: "succeeded", trigger: "manual" } });
      await db.run.create({
        data: { id: rootRunId, agentId: coder, status: "succeeded", parentRunId: openerRun, executionManaged: true },
      });
      await db.codingRun.create({
        data: {
          runId: rootRunId,
          task: "Add the jokes endpoint.",
          repository,
          baseRef: "main",
          headRef,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          protectedPaths: [".github/workflows/**", "CODEOWNERS"],
          budgetReservedUsd: 1,
          result: {
            schemaVersion: 1,
            outcome: "pull_request_opened",
            repository,
            baseRef: "main",
            headRef,
            commitSha: HEAD_SHA,
            pullRequestUrl: `https://github.com/${repository}/pull/7`,
            pullRequestNumber: 7,
            summary: OLD_SUMMARY,
            tests: [{ command: "npm test", outcome: "passed" }],
            usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          },
          prDescriptionSha256: descriptionSha256(originalBody),
          prDescriptionRunId: rootRunId,
          prDescriptionOutcome: "written",
        },
      });

      // --- The review requested changes: the description lacks `Resolves #12`. ---
      const firstReview = id("review-1");
      const reviewedAt = new Date(Date.now() - 60_000);
      await db.run.create({
        data: { id: firstReview, agentId: reviewer, status: "succeeded", trigger: "host_event", startedAt: reviewedAt },
      });
      await db.runHostCheck.create({
        data: {
          runId: firstReview,
          provider: "github",
          repository,
          checkId: "1",
          headSha: HEAD_SHA,
          prNumber: 7,
          verdict: "CHANGES_REQUESTED",
          reviewBody: REVIEW_BODY,
          completedAt: new Date(reviewedAt.getTime() + 1_000),
        },
      });
      github.checkRuns.push({
        id: 1,
        name: CHECK_NAME,
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "failure",
        app: { id: APP_ID },
      });
      // Third-party CI on the head, green throughout.
      github.checkRuns.push({
        id: 2,
        name: "ci / test",
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        app: { id: 1 },
      });

      // --- Production components; only GitHub's HTTP API, git, the launcher and sessions are fakes. ---
      const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs1",
        format: "pem",
      });
      const client = new GitHubAppClient({ appId: String(APP_ID), privateKey: key.toString() }, github.fetch);
      const reviewHost = new GitHubReviewHost(client);
      const workRoot = await mkdtemp(join(tmpdir(), "wardby-fixdesc-"));
      workRoots.push(workRoot);
      const vcs = new RoutingVcsProvider({
        github: new GitVcsProvider({
          rootDir: join(workRoot, "vcs"),
          remote: new GitHubRemote({ github: client, sleep: async () => {} }),
          git: new ScriptedGit(`https://github.com/${repository}.git`, headRef),
        }),
        local: null,
      });
      const nativeStarts: string[] = [];
      const nativeExecutor: Executor = {
        start: async (runId) => {
          nativeStarts.push(runId);
        },
        stop: async () => {},
      };
      const repoAccess = { authorizeUse: async () => ({ ok: true }) } as unknown as RepoAccessGate;
      const deps = { db, executor: nativeExecutor, hosts: { github: reviewHost }, repoAccess };

      // --- 1. The review's finalizer starts a fix round. ---
      await startReviewFixAfterReview(firstReview, deps);
      expect(nativeStarts).toHaveLength(1);
      const fixRun = nativeStarts[0];
      await expect(db.run.findUniqueOrThrow({ where: { id: fixRun } })).resolves.toMatchObject({ agentId: delivery });
      expect(github.labels).toEqual(["wardby-autofix-1"]);

      // --- 2. The fix agent delegates to the coding agent, which finds no code to change and
      //        ends with the full description, now carrying `Resolves #12`. ---
      const codingRunId = id("coding");
      await db.run.update({ where: { id: fixRun }, data: { status: "running" } });
      await db.run.create({
        data: { id: codingRunId, agentId: coder, status: "pending", parentRunId: fixRun, executionManaged: true },
      });
      await db.codingRun.create({
        data: {
          runId: codingRunId,
          task: "Address the review of PR #7.",
          repository,
          baseRef: "main",
          headRef,
          rootCodingRunId: rootRunId,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          protectedPaths: [".github/workflows/**", "CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });
      const executor = new ContainerExecutor({
        store: new InMemorySlotStore(db),
        jobs: new FinishedJobs(() => ({
          exitCode: 0,
          reason: "completed",
          resultArtifact: JSON.stringify({
            schemaVersion: 1,
            runId: codingRunId,
            outcome: "no_changes",
            summary: NEW_SUMMARY,
            tests: [
              { command: "npm test", outcome: "passed" },
              { command: "npm run lint", outcome: "passed" },
            ],
          }),
        })),
        vcs,
        sessions,
        capabilities: new RunCapabilityVault(),
        artifactRoot: join(workRoot, "artifacts"),
        workerImage: IMAGE,
        credentialRef: "env:OPENAI_API_KEY",
        limits: { cpus: 1, memoryMb: 1024, pids: 64, diskMb: 512 },
        maxDiskMb: 8192,
        sleep: async () => {},
        repoAccess,
        // composition.ts runs the same hook (in the background there; awaited here).
        onCodingRunTerminal: (runId) => reReviewAfterNoChangeFix(runId, deps),
      });
      await executor.start(codingRunId);

      // The description was PATCHed once, through the routing provider's no-push refresh.
      expect(github.descriptionPatches).toHaveLength(1);
      const patched = github.body;
      expect(github.descriptionPatches[0]).toBe(patched);
      expect(patched.startsWith(`<!-- wardby:${rootRunId} -->\n`)).toBe(true);
      expect(patched).toContain(NEW_SUMMARY);
      expect(patched).toContain("Resolves #12");
      // Tests rebuilt from this round's run.
      expect(patched).toContain("`npm run lint`: passed");
      expect(originalBody).not.toContain("npm run lint");
      expect(patched.endsWith(`<!-- wardby-latest:${codingRunId} -->`)).toBe(true);
      expect(patched.match(/<!-- wardby:/g)).toHaveLength(1);

      // The coding run succeeded with no change, and the root now records the new body's hash.
      const coding = await db.codingRun.findUniqueOrThrow({
        where: { runId: codingRunId },
        select: { result: true, prDescriptionOutcome: true, run: { select: { status: true } } },
      });
      expect(coding.run.status).toBe("succeeded");
      expect(coding.result).toMatchObject({ outcome: "no_changes", summary: NEW_SUMMARY });
      expect(coding.prDescriptionOutcome).toBe("replaced");
      await expect(
        db.codingRun.findUniqueOrThrow({
          where: { runId: rootRunId },
          select: { prDescriptionSha256: true, prDescriptionRunId: true },
        }),
      ).resolves.toEqual({ prDescriptionSha256: descriptionSha256(patched), prDescriptionRunId: codingRunId });

      // --- 3. The terminal hook started exactly one re-review of the unchanged head. ---
      const patchAt = github.requests.indexOf(`PATCH /repos/${repository}/pulls/7`);
      expect(patchAt).toBeGreaterThan(-1);
      expect(nativeStarts).toHaveLength(2);
      const reReview = nativeStarts[1];
      await expect(db.run.findUniqueOrThrow({ where: { id: reReview } })).resolves.toMatchObject({ agentId: reviewer });
      const reReviewCheck = await db.runHostCheck.findUniqueOrThrow({ where: { runId: reReview } });
      expect(reReviewCheck).toMatchObject({ headSha: HEAD_SHA, prNumber: 7, verdict: null });
      expect(github.labels).toEqual(["wardby-autofix-1", "wardby-autofix-2"]);
      // The re-review read the PR after the PATCH, and still resolved the root's marker from the new body.
      expect(github.requests.lastIndexOf(`GET /repos/${repository}/pulls/7`)).toBeGreaterThan(patchAt);

      // --- 4. The re-review approves (what its publish tool writes: the check and the verdict). ---
      await reviewHost.completeCheck(repository, {
        checkId: reReviewCheck.checkId,
        conclusion: "success",
        title: "Approved",
        summary: "The description now resolves #12.",
      });
      await db.runHostCheck.update({
        where: { runId: reReview },
        data: { verdict: "APPROVED", reviewBody: "LGTM", completedAt: new Date() },
      });
      await db.run.update({ where: { id: reReview }, data: { status: "succeeded" } });

      // --- 5. markReadyWhenPassing marks the PR ready, once. ---
      await expect(markReadyAfterRun({ db, hosts: { github: reviewHost } }, reReview)).resolves.toBe("marked");
      expect(github.markReadyMutations).toEqual([{ id: "PR_node_7" }]);
      expect(github.pr.draft).toBe(false);
      const root = await db.codingRun.findUniqueOrThrow({
        where: { runId: rootRunId },
        select: { markedReadyAt: true },
      });
      expect(root.markedReadyAt).toBeInstanceOf(Date);
      // The description mark-ready saw is the rewritten one.
      expect(github.body).toBe(patched);
    });
  },
);
