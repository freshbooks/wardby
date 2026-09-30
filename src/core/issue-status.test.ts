import { describe, expect, it, vi } from "vitest";
import { adfToText, markdownToAdf } from "../providers/issue-tracker/adf.js";
import { isStatusComment } from "../providers/issue-tracker/jira.js";
import type { IssueTracker } from "../providers/issue-tracker/types.js";
import {
  closeOrphanedIssueStatuses,
  completeIssueStatus,
  postIssueWorkingStatus,
  toJiraMarkdown,
} from "./issue-status.js";

function tracker(): IssueTracker {
  return {
    provider: "jira",
    botAccountId: vi.fn(async () => "bot-1"),
    identity: vi.fn(async () => ({ accountId: "bot-1", displayName: "bot", accountType: "app" })),
    transitions: vi.fn(),
    transitionTo: vi.fn(),
    editableFields: vi.fn(),
    editFields: vi.fn(),
    linkTypes: vi.fn(),
    linkIssues: vi.fn(),
    getProperty: vi.fn(),
    setProperty: vi.fn(),
    getIssue: vi.fn(),
    issueProject: vi.fn(async (key: string) => key.slice(0, key.lastIndexOf("-"))),
    search: vi.fn(),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({ id: "c-1", url: "u" })),
    editComment: vi.fn(async () => undefined),
    readComment: vi.fn(),
    issueUrl: (k) => `https://your-site.atlassian.net/browse/${k}`,
  };
}

function db(
  row: Record<string, unknown> | null,
  run: Record<string, unknown> = { id: "r1", status: "running", finalText: null, agentId: "a1" },
  extra: Record<string, unknown> = {},
  link: Record<string, unknown> | null = { commentVisibilityRole: null },
) {
  return {
    agentIssueProject: { findUnique: vi.fn(async () => link) },
    runIssueStatus: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => undefined),
    },
    run: {
      findUnique: vi.fn(async () => run),
      findMany: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({ _sum: { costUsd: null } })),
      ...extra,
    },
  } as never;
}

describe("toJiraMarkdown", () => {
  it("turns the run footer into italics and PR refs into links", () => {
    expect(toJiraMarkdown("✅ Opened o/r#4.\n\n<sub>wardby run `r1`</sub>")).toBe(
      "✅ Opened [o/r#4](https://github.com/o/r/pull/4).\n\n_wardby run `r1`_",
    );
  });
});

describe("completeIssueStatus after the agent was unlinked", () => {
  const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-9", completedAt: null };
  const finished = { id: "r1", status: "succeeded", finalText: "SECRET REPLY" } as never;

  it("edits the comment with a status-only outcome and completes the row", async () => {
    const t = tracker();
    const d = db(row, { id: "r1", agentId: "a1" }, {}, null);
    await completeIssueStatus(d, finished, { jira: t });
    expect((d as any).agentIssueProject.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId_provider_projectKey: { agentId: "a1", provider: "jira", projectKey: "PROJ" } },
      }),
    );
    const md = (t.editComment as any).mock.calls[0][2].markdown as string;
    expect(md).toContain("Stopped reporting: this agent is no longer linked to PROJ.");
    expect(md).not.toContain("SECRET REPLY");
    expect(md.trimEnd().split("\n").pop()).toMatch(/wardby run/);
    expect((d as any).runIssueStatus.update).toHaveBeenCalled();
  });

  it("never posts a new comment into an unlinked project; it completes the row", async () => {
    const t = tracker();
    const d = db({ ...row, commentId: null }, { id: "r1", agentId: "a1" }, {}, null);
    await completeIssueStatus(d, finished, { jira: t }, { postIfMissing: true });
    expect(t.comment).not.toHaveBeenCalled();
    expect(t.editComment).not.toHaveBeenCalled();
    expect((d as any).runIssueStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: null, completedAt: expect.any(Date) },
    });
  });

  it.each([
    ["the run row is missing", null],
    ["the run has no agent", { id: "r1", agentId: null }],
  ])("treats %s as unlinked and leaks no reply", async (_n, runRow) => {
    const t = tracker();
    const d = db(row, runRow as never, {}, { commentVisibilityRole: null });
    await completeIssueStatus(d, finished, { jira: t });
    const md = (t.editComment as any).mock.calls[0][2].markdown as string;
    expect(md).toContain("no longer linked to PROJ");
    expect(md).not.toContain("SECRET REPLY");
  });

  it("posts a new comment with the link's current visibility role", async () => {
    const t = tracker();
    const d = db(
      { ...row, commentId: null, visibilityRole: "Old" },
      { id: "r1", agentId: "a1" },
      {},
      {
        commentVisibilityRole: "Current",
      },
    );
    await completeIssueStatus(d, finished, { jira: t }, { postIfMissing: true });
    expect(t.comment).toHaveBeenCalledWith("PROJ-1", expect.objectContaining({ visibilityRole: "Current" }));
    expect((t.comment as any).mock.calls[0][1].markdown).toContain("SECRET REPLY");
  });
});

describe("postIssueWorkingStatus", () => {
  it("posts once with the row's visibility and claims the row", async () => {
    const t = tracker();
    const d = db({
      runId: "r1",
      issueKey: "PROJ-1",
      provider: "jira",
      commentId: null,
      completedAt: null,
      visibilityRole: "Developers",
    });
    await postIssueWorkingStatus(d, { jira: t }, "r1");
    expect(t.comment).toHaveBeenCalledWith("PROJ-1", expect.objectContaining({ visibilityRole: "Developers" }));
    expect((d as any).runIssueStatus.updateMany).toHaveBeenCalledWith({
      where: { runId: "r1", commentId: null, completedAt: null },
      data: { commentId: "c-1" },
    });
  });
  it("does nothing when a comment already exists", async () => {
    const t = tracker();
    await postIssueWorkingStatus(
      db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "x", completedAt: null }),
      { jira: t },
      "r1",
    );
    expect(t.comment).not.toHaveBeenCalled();
  });
});

describe("completeIssueStatus", () => {
  it("edits the working comment with the outcome and completes the row", async () => {
    const t = tracker();
    const d = db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null });
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "All done" }, { jira: t });
    expect(t.editComment).toHaveBeenCalledWith("PROJ-1", "c-1", { markdown: expect.stringContaining("All done") });
    expect((d as any).runIssueStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: "c-1", completedAt: expect.any(Date) },
    });
  });
  it('says "Done." on Jira when the run opened no pull request', async () => {
    const t = tracker();
    const d = db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null });
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "Triaged" }, { jira: t });
    const { markdown } = (t.editComment as any).mock.calls[0][2];
    expect(markdown).toMatch(/^✅ Done\./);
    expect(markdown).toContain("Triaged");
    expect(markdown).not.toContain("Finished without");
  });
  it("shows the run's and its children's spend above the footer, which stays last", async () => {
    const t = tracker();
    const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null };
    const d = db(
      row,
      { id: "r1", status: "succeeded", finalText: "ok", costUsd: 0.01 },
      {
        aggregate: vi.fn(async () => ({ _sum: { costUsd: { toString: () => "0.0023" } } })),
      },
    );
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "ok" }, { jira: t });
    const { markdown } = (t.editComment as any).mock.calls[0][2];
    const lines = markdown.trimEnd().split("\n");
    expect(markdown).toContain("Agent spend: $0.0123");
    expect(lines.at(-1)).toMatch(/^_wardby run `r1`_$/);
    expect(isStatusComment(adfToText(markdownToAdf(markdown)))).toBe(true);
    expect((d as any).run.aggregate).toHaveBeenCalledWith({ where: { parentRunId: "r1" }, _sum: { costUsd: true } });
  });
  it("treats null costs as zero", async () => {
    const t = tracker();
    const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null };
    const d = db(
      row,
      { id: "r1", status: "succeeded", finalText: "ok", costUsd: null },
      {
        aggregate: vi.fn(async () => ({ _sum: { costUsd: null } })),
      },
    );
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "ok" }, { jira: t });
    expect((t.editComment as any).mock.calls[0][2].markdown).toContain("Agent spend: $0.0000");
  });
  it("omits the spend line but still posts the outcome when the cost lookup fails", async () => {
    const t = tracker();
    const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null };
    const d = db(
      row,
      { id: "r1", status: "succeeded", finalText: "ok" },
      {
        aggregate: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    );
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "ok" }, { jira: t });
    const { markdown } = (t.editComment as any).mock.calls[0][2];
    expect(markdown).not.toContain("Agent spend");
    expect(markdown).toContain("wardby run `r1`");
  });
  it("leaves a comment-less row to the working-status follow-up unless postIfMissing", async () => {
    const t = tracker();
    const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: null, completedAt: null };
    await completeIssueStatus(db(row), { id: "r1", status: "failed", finalText: null }, { jira: t });
    expect(t.comment).not.toHaveBeenCalled();
    await completeIssueStatus(
      db(row),
      { id: "r1", status: "failed", finalText: null },
      { jira: t },
      { postIfMissing: true },
    );
    expect(t.comment).toHaveBeenCalledOnce();
  });
  it("never throws when Jira fails", async () => {
    const t = tracker();
    (t.editComment as any).mockRejectedValue(new Error("boom"));
    const d = db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null });
    await expect(
      completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: null }, { jira: t }),
    ).resolves.toBeUndefined();
    expect((d as any).runIssueStatus.update).not.toHaveBeenCalled();
  });
});

describe("closeOrphanedIssueStatuses", () => {
  const NOW = new Date("2026-09-30T12:00:00.000Z");

  function orphanDb(rows: Array<Record<string, unknown>>) {
    return {
      runIssueStatus: {
        findMany: vi.fn(async () => rows.map((r) => ({ run: { id: r.runId, status: "lost", finalText: null } }))),
        findUnique: vi.fn(async ({ where }: any) => rows.find((r) => r.runId === where.runId) ?? null),
        update: vi.fn(async () => undefined),
      },
      run: { findUnique: vi.fn(async () => ({ agentId: "a1" })), findMany: vi.fn(async () => []) },
      agentIssueProject: { findUnique: vi.fn(async () => ({ commentVisibilityRole: "Dev" })) },
    } as never;
  }

  it("queries open statuses of configured providers whose run ended 2 minutes to a day ago, newest first", async () => {
    const d = orphanDb([]);
    await closeOrphanedIssueStatuses(d, { jira: tracker() }, NOW);
    expect((d as any).runIssueStatus.findMany).toHaveBeenCalledWith({
      where: {
        completedAt: null,
        provider: { in: ["jira"] },
        run: {
          status: { notIn: ["pending", "running"] },
          finishedAt: {
            lte: new Date(NOW.getTime() - 2 * 60 * 1000),
            gte: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
          },
        },
      },
      select: { run: { select: { id: true, status: true, finalText: true } } },
      orderBy: { run: { finishedAt: "desc" } },
      take: 20,
    });
  });

  it("posts the outcome as a new comment when the run died before its working comment", async () => {
    const t = tracker();
    const d = orphanDb([
      { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: null, completedAt: null, visibilityRole: "Dev" },
    ]);
    await closeOrphanedIssueStatuses(d, { jira: t }, NOW);
    expect(t.comment).toHaveBeenCalledWith("PROJ-1", {
      markdown: expect.stringMatching(/^❌ Interrupted before it finished/),
      visibilityRole: "Dev",
    });
    expect((d as any).runIssueStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: "c-1", completedAt: expect.any(Date) },
    });
  });

  it("never queries without a configured tracker", async () => {
    const d = orphanDb([]);
    await closeOrphanedIssueStatuses(d, undefined, NOW);
    await closeOrphanedIssueStatuses(d, {}, NOW);
    expect((d as any).runIssueStatus.findMany).not.toHaveBeenCalled();
  });
});
