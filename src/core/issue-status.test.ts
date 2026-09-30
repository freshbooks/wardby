import { describe, expect, it, vi } from "vitest";
import type { IssueTracker } from "../providers/issue-tracker/types.js";
import { completeIssueStatus, postIssueWorkingStatus, toJiraMarkdown } from "./issue-status.js";

function tracker(): IssueTracker {
  return {
    provider: "jira",
    botAccountId: vi.fn(async () => "bot-1"),
    getIssue: vi.fn(),
    search: vi.fn(),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({ id: "c-1", url: "u" })),
    editComment: vi.fn(async () => undefined),
    readComment: vi.fn(),
    issueUrl: (k) => `https://your-site.atlassian.net/browse/${k}`,
  };
}

function db(row: Record<string, unknown> | null, run = { id: "r1", status: "running", finalText: null }) {
  return {
    runIssueStatus: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => undefined),
    },
    run: { findUnique: vi.fn(async () => run), findMany: vi.fn(async () => []) },
  } as never;
}

describe("toJiraMarkdown", () => {
  it("turns the run footer into italics and PR refs into links", () => {
    expect(toJiraMarkdown("✅ Opened o/r#4.\n\n<sub>wardby run `r1`</sub>")).toBe(
      "✅ Opened [o/r#4](https://github.com/o/r/pull/4).\n\n_wardby run `r1`_",
    );
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
