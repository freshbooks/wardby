import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isLocalRepository,
  loadLocalRepoRoots,
  LocalRepoError,
  normalizeLocalRepository,
  resolveLocalRepository,
} from "./local-repo.js";
import { CodingTaskInputSchema } from "./protocol.js";

const run = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "--initial-branch=main", dir]);
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (error) {
    return error instanceof LocalRepoError ? error.code : `other:${String(error)}`;
  }
  return undefined;
}

describe("local repositories", () => {
  let base: string;
  let root: string;
  let outside: string;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "wardby-local-repo-")));
    root = join(base, "root");
    outside = join(base, "other");
    await initRepo(join(root, "repo"));
    await initRepo(outside);
    await initRepo(join(base, "rootX"));
    await mkdir(join(root, "plain"), { recursive: true });
    await symlink(outside, join(root, "link"));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("identifies and normalizes", () => {
    expect(isLocalRepository("local:/a")).toBe(true);
    expect(isLocalRepository("a/b")).toBe(false);
    expect(normalizeLocalRepository("local:/a/b/")).toBe("local:/a/b");
    expect(() => normalizeLocalRepository("local:relative")).toThrow();
    expect(() => normalizeLocalRepository("local:/a\0b")).toThrow();
  });

  it("loads roots, dropping empties and reporting missing", () => {
    const missing = join(base, "nope");
    const out = loadLocalRepoRoots({ LOCAL_REPO_ROOTS: [root, "", missing].join(delimiter) });
    expect(out).toEqual({ roots: [root], missing: [missing] });
    expect(loadLocalRepoRoots({})).toEqual({ roots: [], missing: [] });
  });

  it("rejects when no roots are set", async () => {
    expect(await codeOf(resolveLocalRepository(`local:${root}/repo`, []))).toBe("local_repo_not_allowed");
  });

  it("accepts a repo inside a root", async () => {
    expect(await resolveLocalRepository(`local:${root}/repo`, [root])).toEqual({
      repository: `local:${root}/repo`,
      path: `${root}/repo`,
    });
  });

  it("accepts the root itself with a trailing slash", async () => {
    await initRepo(join(base, "selfroot"));
    const self = join(base, "selfroot");
    expect((await resolveLocalRepository(`local:${self}/`, [self])).path).toBe(self);
  });

  it("accepts when the second root matches", async () => {
    expect((await resolveLocalRepository(`local:${root}/repo`, [join(base, "zzz"), root])).path).toBe(`${root}/repo`);
  });

  it("rejects root/../other", async () => {
    expect(await codeOf(resolveLocalRepository(`local:${root}/../other`, [root]))).toBe("local_repo_not_allowed");
  });

  it("rejects a symlink pointing outside the root", async () => {
    expect(await codeOf(resolveLocalRepository(`local:${root}/link`, [root]))).toBe("local_repo_not_allowed");
  });

  it("rejects a prefix sibling", async () => {
    expect(await codeOf(resolveLocalRepository(`local:${base}/rootX`, [root]))).toBe("local_repo_not_allowed");
  });

  it("rejects a non-repo directory, a missing path, and a repo subdirectory", async () => {
    expect(await codeOf(resolveLocalRepository(`local:${root}/plain`, [root]))).toBe("local_repo_not_found");
    expect(await codeOf(resolveLocalRepository(`local:${root}/missing`, [root]))).toBe("local_repo_not_found");
    await mkdir(join(root, "repo", "sub"), { recursive: true });
    expect(await codeOf(resolveLocalRepository(`local:${root}/repo/sub`, [root]))).toBe("local_repo_not_found");
  });

  it("includes the code in the error message", async () => {
    await expect(resolveLocalRepository(`local:${root}/plain`, [root])).rejects.toThrow(/local_repo_not_found/);
  });
});

describe("coding protocol repository", () => {
  const input = {
    schemaVersion: 1,
    runId: "run_123",
    baseRef: "main",
    headRef: "wardby/x",
    task: "t",
    model: "claude-sonnet-4-6",
    budgetUsd: 1,
    deadlineAt: "2030-01-01T00:00:00Z",
  };
  const repoIssues = (repository: string) => {
    const r = CodingTaskInputSchema.safeParse({ ...input, repository });
    return r.success ? [] : r.error.issues.filter((i) => i.path[0] === "repository");
  };

  it("accepts local:/x/y syntactically and rejects file:///x", () => {
    expect(repoIssues("local:/x/y")).toEqual([]);
    expect(repoIssues("file:///x")).not.toEqual([]);
    expect(repoIssues("local:relative")).not.toEqual([]);
  });
});
