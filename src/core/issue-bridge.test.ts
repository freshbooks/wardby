import { describe, expect, it, vi } from "vitest";
import type { IssueTracker } from "../providers/issue-tracker/types.js";
import { handlePullRequestClosed } from "./issue-bridge.js";

function tracker(): IssueTracker {
  return {
    provider: "jira",
    botAccountId: vi.fn(async () => "bot-1"),
    identity: vi.fn(async () => ({ accountId: "bot-1", displayName: "bot", accountType: "app" })),
    transitions: vi.fn(),
    transitionTo: vi.fn(async (_k: string, to: string) => ({ transitionId: "31", toStatus: to })),
    editableFields: vi.fn(),
    editFields: vi.fn(),
    linkTypes: vi.fn(),
    linkIssues: vi.fn(),
    addRemoteLink: vi.fn(async () => undefined),
    getProperty: vi.fn(),
    setProperty: vi.fn(),
    getIssue: vi.fn(),
    issueProject: vi.fn(),
    search: vi.fn(),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({ id: "c-1", url: "u" })),
    editComment: vi.fn(),
    readComment: vi.fn(),
    issueUrl: (k) => `https://your-site.atlassian.net/browse/${k}`,
  };
}

const REPO = "your-org/your-repo";
const ROW = {
  id: "ipr-1",
  issueProvider: "jira",
  issueKey: "PROJ-7",
  codeProvider: "github",
  repository: REPO,
  number: 12,
  url: `https://github.com/${REPO}/pull/12`,
  agentId: "a1",
  openedByRunId: "r-code",
  state: "open",
};
const LINK = { access: "write", commentVisibilityRole: null, onPullRequestMerged: "Done" };

function db(rows: Array<Record<string, unknown>> = [ROW], link: Record<string, unknown> | null = LINK, claimed = 1) {
  return {
    issuePullRequest: {
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async () => ({ count: claimed })),
    },
    agentIssueProject: { findUnique: vi.fn(async () => link) },
  };
}

const closed = (merged: boolean) => ({ codeProvider: "github", repository: REPO, number: 12, merged });

describe("handlePullRequestClosed", () => {
  it("merged: marks the row, resolves the web link, moves the issue and comments", async () => {
    const t = tracker();
    const d = db();
    await handlePullRequestClosed(d as never, { jira: t }, closed(true));
    expect(d.issuePullRequest.findMany).toHaveBeenCalledWith({
      where: { codeProvider: "github", repository: REPO, number: 12, state: "open" },
    });
    expect(d.issuePullRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "ipr-1", state: "open" },
      data: { state: "merged" },
    });
    expect(d.agentIssueProject.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId_provider_projectKey: { agentId: "a1", provider: "jira", projectKey: "PROJ" } },
      }),
    );
    expect(t.addRemoteLink).toHaveBeenCalledWith("PROJ-7", {
      globalId: `wardby:pr:github:${REPO}#12`,
      url: ROW.url,
      title: `${REPO}#12`,
      status: { resolved: true },
    });
    expect(t.transitionTo).toHaveBeenCalledWith("PROJ-7", "Done");
    expect(t.comment).toHaveBeenCalledWith("PROJ-7", {
      markdown: `✅ Pull request [${REPO}#12](${ROW.url}) was merged. Moved to Done.`,
    });
  });

  it("merged without a configured status: comments only, no move", async () => {
    const t = tracker();
    await handlePullRequestClosed(
      db([ROW], { ...LINK, onPullRequestMerged: null }) as never,
      { jira: t },
      closed(true),
    );
    expect(t.transitionTo).not.toHaveBeenCalled();
    expect(t.comment).toHaveBeenCalledWith("PROJ-7", {
      markdown: `✅ Pull request [${REPO}#12](${ROW.url}) was merged.`,
    });
  });

  it("closed unmerged: comments only, in the link's visibility role", async () => {
    const t = tracker();
    const d = db([ROW], { ...LINK, commentVisibilityRole: "Developers" });
    await handlePullRequestClosed(d as never, { jira: t }, closed(false));
    expect(d.issuePullRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { state: "closed" } }));
    expect(t.transitionTo).not.toHaveBeenCalled();
    expect(t.addRemoteLink).not.toHaveBeenCalled();
    expect(t.comment).toHaveBeenCalledWith("PROJ-7", {
      markdown: `Pull request [${REPO}#12](${ROW.url}) was closed without merging.`,
      visibilityRole: "Developers",
    });
  });

  it("an unknown PR (no open row) is a no-op", async () => {
    const t = tracker();
    const d = db([]);
    await handlePullRequestClosed(d as never, { jira: t }, closed(true));
    expect(d.issuePullRequest.updateMany).not.toHaveBeenCalled();
    expect(t.comment).not.toHaveBeenCalled();
  });

  it("a concurrent duplicate that loses the claim does nothing", async () => {
    const t = tracker();
    const d = db([ROW], LINK, 0);
    await handlePullRequestClosed(d as never, { jira: t }, closed(true));
    expect(d.agentIssueProject.findUnique).not.toHaveBeenCalled();
    expect(t.comment).not.toHaveBeenCalled();
    expect(t.transitionTo).not.toHaveBeenCalled();
  });

  it("an unlinked or read-only agent: the row is still marked, but Jira is never called", async () => {
    for (const link of [null, { ...LINK, access: "read" }]) {
      const t = tracker();
      const d = db([ROW], link);
      await handlePullRequestClosed(d as never, { jira: t }, closed(true));
      expect(d.issuePullRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { state: "merged" } }),
      );
      expect(t.comment).not.toHaveBeenCalled();
      expect(t.transitionTo).not.toHaveBeenCalled();
      expect(t.addRemoteLink).not.toHaveBeenCalled();
    }
  });

  it("a refused move is noted in the comment; nothing throws", async () => {
    const t = tracker();
    vi.mocked(t.transitionTo).mockRejectedValue(new Error("no such transition"));
    vi.mocked(t.addRemoteLink).mockRejectedValue(new Error("boom"));
    await expect(handlePullRequestClosed(db() as never, { jira: t }, closed(true))).resolves.toBeUndefined();
    expect(t.comment).toHaveBeenCalledWith("PROJ-7", {
      markdown: `✅ Pull request [${REPO}#12](${ROW.url}) was merged. Could not move PROJ-7 to "Done"; it may need a manual move.`,
    });
  });

  it("handles every issue the PR is linked to, and survives a failing one", async () => {
    const t = tracker();
    vi.mocked(t.comment).mockRejectedValueOnce(new Error("jira down"));
    const d = db([ROW, { ...ROW, id: "ipr-2", issueKey: "PROJ-8" }]);
    await expect(handlePullRequestClosed(d as never, { jira: t }, closed(false))).resolves.toBeUndefined();
    expect(t.comment).toHaveBeenCalledTimes(2);
    expect(vi.mocked(t.comment).mock.calls[1][0]).toBe("PROJ-8");
  });

  it("no trackers, or a failing lookup: no-op, no throw", async () => {
    const d = db();
    await handlePullRequestClosed(d as never, undefined, closed(true));
    expect(d.issuePullRequest.findMany).not.toHaveBeenCalled();
    d.issuePullRequest.findMany.mockRejectedValue(new Error("db"));
    await expect(handlePullRequestClosed(d as never, { jira: tracker() }, closed(true))).resolves.toBeUndefined();
  });

  it("an issue provider with no configured tracker still marks the row", async () => {
    const d = db([{ ...ROW, issueProvider: "linear" }]);
    await handlePullRequestClosed(d as never, { jira: tracker() }, closed(false));
    expect(d.issuePullRequest.updateMany).toHaveBeenCalled();
    expect(d.agentIssueProject.findUnique).not.toHaveBeenCalled();
  });
});
