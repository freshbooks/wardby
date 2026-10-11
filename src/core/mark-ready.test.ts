import { describe, expect, it, vi } from "vitest";
import { markReadyAfterRun, maybeMarkReady } from "./mark-ready.js";

const SHA = "a".repeat(40);

interface CheckView {
  status: string;
  conclusion: string | null;
}

function setup(
  over: Partial<{
    links: unknown[];
    origin: Record<string, unknown>;
    checks: Map<string, CheckView>;
    ci: Record<string, unknown>;
    root: Record<string, unknown> | null;
    claimCount: number;
    mark: "marked" | "skipped" | Error;
    hostCheck: Record<string, unknown> | null;
  }> = {},
) {
  const links = over.links ?? [
    { agentId: "builder", access: "write", triggers: [], checkName: null, markReadyWhenPassing: true },
    {
      agentId: "reviewer",
      access: "write",
      triggers: ["pull_request"],
      checkName: "wardby review",
      markReadyWhenPassing: false,
    },
  ];
  const db = {
    agentRepository: { findMany: vi.fn(async (_args: unknown) => links) },
    codingRun: {
      findUnique: vi.fn(async (_args: unknown): Promise<Record<string, unknown> | null> =>
        over.root === undefined
          ? {
              runId: "root",
              repository: "acme/web",
              rootCodingRunId: null,
              markedReadyAt: null,
              run: { agentId: "builder" },
            }
          : over.root,
      ),
      updateMany: vi.fn(async (_args: unknown) => ({ count: over.claimCount ?? 1 })),
    },
    runHostCheck: {
      findUnique: vi.fn(async (_args: unknown) => (over.hostCheck === undefined ? null : over.hostCheck)),
    },
  };
  const host = {
    pullRequestOrigin: vi.fn(async (_repository: string, _prNumber: number) => ({
      headSha: SHA,
      isFork: false,
      state: "open",
      draft: true,
      markerRunId: "root",
      labels: [],
      ...over.origin,
    })),
    readOwnChecks: vi.fn(
      async (_repository: string, _headSha: string, _names: string[]) =>
        over.checks ?? new Map([["wardby review", { status: "completed", conclusion: "success" }]]),
    ),
    readCi: vi.fn(async () => ({
      headSha: SHA,
      state: "passing",
      checks: [],
      truncated: false,
      statusesUnavailable: false,
      ...over.ci,
    })),
    markReadyForReview: vi.fn(async (_repository: string, _prNumber: number, _sha: string) => {
      const m = over.mark ?? "marked";
      if (m instanceof Error) throw m;
      return m;
    }),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  return { db, host, log, deps: { db, hosts: { github: host }, log } as never };
}

const rootRow = (fields: Record<string, unknown>) => ({
  runId: "root",
  repository: "acme/web",
  rootCodingRunId: null,
  markedReadyAt: null,
  run: { agentId: "builder" },
  ...fields,
});

describe("maybeMarkReady", () => {
  it("marks when every condition holds", async () => {
    const { deps, host, db, log } = setup();
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(host.markReadyForReview).toHaveBeenCalledWith("acme/web", 7, SHA);
    expect(host.readOwnChecks).toHaveBeenCalledWith("acme/web", SHA, ["wardby review", "wardby merge order"]);
    expect(db.codingRun.updateMany).toHaveBeenCalledTimes(1);
    const claim = (db.codingRun.updateMany.mock.calls[0] as unknown[])[0] as {
      where: { runId: string; markedReadyAt: null };
      data: { markedReadyAt: Date };
    };
    expect(claim.where).toEqual({ runId: "root", markedReadyAt: null });
    expect(claim.data.markedReadyAt).toBeInstanceOf(Date);
    expect(log.info).toHaveBeenCalled();
  });

  it("is off with no host reads when no write link opted in", async () => {
    const { deps, host } = setup({
      links: [{ agentId: "builder", access: "write", triggers: [], checkName: null, markReadyWhenPassing: false }],
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("off");
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("is off when only a read link opted in", async () => {
    const { deps, host } = setup({
      links: [{ agentId: "builder", access: "read", triggers: [], checkName: null, markReadyWhenPassing: true }],
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("off");
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("is off when the provider has no host", async () => {
    const { deps } = setup();
    expect(await maybeMarkReady(deps, "acme/web", 7, "local")).toBe("off");
  });

  it.each([
    [
      "no reviewer link",
      { links: [{ agentId: "builder", access: "write", triggers: [], checkName: null, markReadyWhenPassing: true }] },
    ],
    ["not a draft", { origin: { draft: false } }],
    ["closed", { origin: { state: "closed" } }],
    ["a fork", { origin: { isFork: true } }],
    ["no Wardby marker", { origin: { markerRunId: undefined } }],
    ["review failed", { checks: new Map([["wardby review", { status: "completed", conclusion: "failure" }]]) }],
    ["review missing", { checks: new Map() }],
    ["review in progress", { checks: new Map([["wardby review", { status: "in_progress", conclusion: null }]]) }],
    [
      "merge order waiting",
      {
        checks: new Map([
          ["wardby review", { status: "completed", conclusion: "success" }],
          ["wardby merge order", { status: "in_progress", conclusion: null }],
        ]),
      },
    ],
    ["CI pending", { ci: { state: "pending" } }],
    ["CI failing", { ci: { state: "failing" } }],
    ["CI unavailable", { ci: { state: "unavailable" } }],
    ["CI truncated", { ci: { truncated: true } }],
    ["the marker names no coding run", { root: null }],
    ["opened by another agent", { root: rootRow({ run: { agentId: "someone-else" } }) }],
    ["opener repository differs", { root: rootRow({ repository: "acme/other" }) }],
  ])("is not ready when %s", async (_why, over) => {
    const { deps, host } = setup(over);
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("accepts a repository with no CI", async () => {
    const { deps } = setup({ ci: { state: "none" } });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
  });

  it("accepts a successful merge order check", async () => {
    const { deps } = setup({
      checks: new Map([
        ["wardby review", { status: "completed", conclusion: "success" }],
        ["wardby merge order", { status: "completed", conclusion: "success" }],
      ]),
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
  });

  it("matches the opener's repository case-insensitively", async () => {
    const { deps } = setup({ root: rootRow({ repository: "Acme/Web" }) });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
  });

  it("skips when already marked once", async () => {
    const { deps, host } = setup({ root: rootRow({ markedReadyAt: new Date() }) });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("skipped");
    expect(host.readOwnChecks).not.toHaveBeenCalled();
  });

  it("skips when another evaluation won the claim", async () => {
    const { deps, host } = setup({ claimCount: 0 });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("skipped");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("releases its claim when the host skips or fails", async () => {
    for (const mark of ["skipped", new Error("boom")] as const) {
      const { deps, db } = setup({ mark });
      expect(await maybeMarkReady(deps, "acme/web", 7)).toBe(mark === "skipped" ? "skipped" : "failed");
      expect(db.codingRun.updateMany).toHaveBeenCalledTimes(2);
      const claim = (db.codingRun.updateMany.mock.calls[0] as unknown[])[0] as { data: { markedReadyAt: Date } };
      const release = (db.codingRun.updateMany.mock.calls[1] as unknown[])[0] as {
        where: { markedReadyAt: Date };
        data: { markedReadyAt: null };
      };
      expect(release.data.markedReadyAt).toBeNull();
      expect(release.where.markedReadyAt).toBeInstanceOf(Date);
      expect(release.where.markedReadyAt).toBe(claim.data.markedReadyAt);
    }
  });

  it("resolves a continuation's root coding run", async () => {
    const { deps, db } = setup();
    db.codingRun.findUnique
      .mockResolvedValueOnce({
        runId: "cont",
        repository: "acme/web",
        rootCodingRunId: "root",
        markedReadyAt: null,
        run: { agentId: "fixer" },
      })
      .mockResolvedValueOnce(rootRow({}));
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(db.codingRun.findUnique).toHaveBeenCalledTimes(2);
    expect((db.codingRun.findUnique.mock.calls[1] as unknown[])[0]).toMatchObject({ where: { runId: "root" } });
    const claim = (db.codingRun.updateMany.mock.calls[0] as unknown[])[0] as { where: { runId: string } };
    expect(claim.where.runId).toBe("root");
  });

  it("is not ready when a continuation's root is missing", async () => {
    const { deps, db, host } = setup();
    db.codingRun.findUnique
      .mockResolvedValueOnce({
        runId: "cont",
        repository: "acme/web",
        rootCodingRunId: "root",
        markedReadyAt: null,
        run: { agentId: "builder" },
      })
      .mockResolvedValueOnce(null);
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const { deps, host, log } = setup();
    host.pullRequestOrigin.mockRejectedValueOnce(new Error("down"));
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("failed");
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("markReadyAfterRun", () => {
  it("is null when the run reviewed no pull request", async () => {
    const { deps, host } = setup();
    expect(await markReadyAfterRun(deps, "run-1")).toBeNull();
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("is null when the row has no pull request number", async () => {
    const { deps } = setup({
      hostCheck: { provider: "github", repository: "acme/web", prNumber: null, verdict: "APPROVE" },
    });
    expect(await markReadyAfterRun(deps, "run-1")).toBeNull();
  });

  it("is null when the run published no verdict", async () => {
    const { deps, host } = setup({
      hostCheck: { provider: "github", repository: "acme/web", prNumber: 7, verdict: null },
    });
    expect(await markReadyAfterRun(deps, "run-1")).toBeNull();
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("delegates to maybeMarkReady for the reviewed pull request", async () => {
    const { deps, db, host } = setup({
      hostCheck: { provider: "github", repository: "acme/web", prNumber: 7, verdict: "APPROVE" },
    });
    expect(await markReadyAfterRun(deps, "run-1")).toBe("marked");
    expect((db.runHostCheck.findUnique.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { runId: "run-1" } });
    expect(host.markReadyForReview).toHaveBeenCalledWith("acme/web", 7, SHA);
  });

  it("never throws", async () => {
    const { deps, db } = setup();
    db.runHostCheck.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await markReadyAfterRun(deps, "run-1")).toBe("failed");
  });
});
