import { describe, expect, it, vi } from "vitest";
import { buildVcsProvider } from "./index.js";
import { RoutingVcsProvider } from "./routing.js";
import type { PreparedWorkspace, VcsPrepareInput, VcsProvider } from "./types.js";

function fake(tag: string): VcsProvider & { calls: string[] } {
  const calls: string[] = [];
  const workspace = (repository: string) => ({ repository, tag }) as unknown as PreparedWorkspace;
  return {
    calls,
    prepareWorkspace: vi.fn(async (input: VcsPrepareInput) => {
      calls.push(`prepare:${input.repository}`);
      return workspace(input.repository);
    }),
    recoverWorkspace: vi.fn(async (input: VcsPrepareInput) => {
      calls.push(`recover:${input.repository}`);
      return workspace(input.repository);
    }),
    finalizeChanges: vi.fn(async (w: PreparedWorkspace) => {
      calls.push(`finalize:${w.repository}`);
      return { outcome: "no_changes" as const, repository: w.repository, baseRef: "main", baseCommit: "a".repeat(40) };
    }),
    cleanup: vi.fn(async (w: PreparedWorkspace) => {
      calls.push(`cleanup:${w.repository}`);
    }),
    notifyContinuationStarted: vi.fn(async (w: PreparedWorkspace) => {
      calls.push(`started:${w.repository}`);
    }),
    notifyContinuationFinished: vi.fn(async (w: PreparedWorkspace) => {
      calls.push(`finished:${w.repository}`);
    }),
    readRepositoryFile: vi.fn(async (input) => {
      calls.push(`file:${input.repository}`);
      return tag;
    }),
  };
}

const prepare = (repository: string): VcsPrepareInput => ({
  runId: "r1",
  repository,
  baseRef: "main",
  headRef: "wardby/run-r1",
  protectedPaths: [],
});

describe("RoutingVcsProvider", () => {
  it("dispatches every method by the repository prefix", async () => {
    const github = fake("github");
    const local = fake("local");
    const routing = new RoutingVcsProvider({ github, local });
    const gh = await routing.prepareWorkspace(prepare("owner/repo"));
    const lo = await routing.prepareWorkspace(prepare("local:/srv/repos/a"));
    await routing.recoverWorkspace(prepare("local:/srv/repos/a"));
    await routing.finalizeChanges(gh);
    await routing.finalizeChanges(lo);
    await routing.cleanup(lo);
    await routing.notifyContinuationStarted?.(lo);
    await routing.notifyContinuationFinished?.(gh, "succeeded");
    expect(
      await routing.readRepositoryFile?.({ repository: "local:/srv/repos/a", ref: "main", path: "x", maxBytes: 1 }),
    ).toBe("local");
    expect(github.calls).toEqual(["prepare:owner/repo", "finalize:owner/repo", "finished:owner/repo"]);
    expect(local.calls).toEqual([
      "prepare:local:/srv/repos/a",
      "recover:local:/srv/repos/a",
      "finalize:local:/srv/repos/a",
      "cleanup:local:/srv/repos/a",
      "started:local:/srv/repos/a",
      "file:local:/srv/repos/a",
    ]);
  });

  it("fails a GitHub repository with vcs_github_not_configured when there is no GitHub provider", async () => {
    const routing = new RoutingVcsProvider({ github: null, local: fake("local") });
    await expect(routing.prepareWorkspace(prepare("owner/repo"))).rejects.toThrow("vcs_github_not_configured");
    await expect(routing.recoverWorkspace(prepare("owner/repo"))).rejects.toThrow("vcs_github_not_configured");
  });

  it("fails a local repository with local_repo_not_allowed when there is no local provider", async () => {
    const routing = new RoutingVcsProvider({ github: fake("github"), local: null });
    await expect(routing.prepareWorkspace(prepare("local:/srv/a"))).rejects.toMatchObject({
      code: "local_repo_not_allowed",
    });
  });

  it("treats notifications as best-effort when the target is not configured", async () => {
    const routing = new RoutingVcsProvider({ github: null, local: null });
    const w = { repository: "owner/repo" } as PreparedWorkspace;
    await expect(routing.notifyContinuationStarted?.(w)).resolves.toBeUndefined();
    await expect(routing.notifyContinuationFinished?.(w, "failed")).resolves.toBeUndefined();
    await expect(
      routing.readRepositoryFile?.({ repository: "owner/repo", ref: "main", path: "x", maxBytes: 1 }),
    ).resolves.toBeNull();
  });
});

describe("buildVcsProvider", () => {
  it("does not throw when only LOCAL_REPO_ROOTS is set, and fails GitHub repositories lazily", async () => {
    const provider = buildVcsProvider({ vcs: "github" }, {}, { LOCAL_REPO_ROOTS: "/tmp" });
    await expect(provider.prepareWorkspace(prepare("owner/repo"))).rejects.toThrow("vcs_github_not_configured");
  });

  it("with neither GitHub App credentials nor roots, every repository is refused lazily", async () => {
    const provider = buildVcsProvider({ vcs: "github" }, {}, {});
    await expect(provider.prepareWorkspace(prepare("owner/repo"))).rejects.toThrow("vcs_github_not_configured");
    await expect(provider.prepareWorkspace(prepare("local:/tmp/a"))).rejects.toMatchObject({
      code: "local_repo_not_allowed",
    });
  });

  it("warns at startup, naming both options, when neither GitHub App credentials nor roots are configured", () => {
    const warn = vi.fn();
    buildVcsProvider({ vcs: "github" }, {}, {}, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("GITHUB_APP_ID");
    expect(message).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(message).toContain("LOCAL_REPO_ROOTS");
  });

  it("does not warn when either GitHub App credentials or roots are configured", () => {
    const warn = vi.fn();
    buildVcsProvider({ vcs: "github" }, {}, { LOCAL_REPO_ROOTS: "/tmp" }, { warn });
    buildVcsProvider({ vcs: "github" }, { appId: "1", privateKey: "k" }, {}, { warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it("makes vcs_github_not_configured actionable, keeping the code prefix", async () => {
    const provider = buildVcsProvider({ vcs: "github" }, {}, {}, { warn: () => {} });
    const error = await provider.prepareWorkspace(prepare("owner/repo")).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      "vcs_github_not_configured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to run coding agents on GitHub repositories",
    );
  });

  it("still rejects an unsupported VCS_PROVIDER", () => {
    expect(() => buildVcsProvider({ vcs: "gitlab" as never }, {}, {})).toThrow("not supported");
  });
});
