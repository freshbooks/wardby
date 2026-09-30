import { describe, expect, it, vi } from "vitest";
import { IssueTrackerError, projectOf, type IssueTracker } from "../providers/issue-tracker/types.js";
import {
  ISSUE_TRACKER_TOOL_DEFS,
  ISSUE_TRACKER_TOOL_NAMES,
  handleIssueTrackerTool,
  scopeJql,
  type IssueProjectLink,
  type IssueToolContext,
} from "./issue-tracker-tools.js";

const WRITE_LINK: IssueProjectLink = {
  provider: "jira",
  projectKey: "PROJ",
  access: "write",
  commentVisibilityRole: "Developers",
};
const READ_LINK: IssueProjectLink = {
  provider: "jira",
  projectKey: "DOCS",
  access: "read",
  commentVisibilityRole: null,
};

function tracker(): IssueTracker {
  return {
    provider: "jira",
    botAccountId: vi.fn(async () => "bot-1"),
    identity: vi.fn(async () => ({ accountId: "bot-1", displayName: "wardby", accountType: "app" })),
    getIssue: vi.fn(async (key: string) => ({ key, projectKey: projectOf(key), summary: "S" }) as never),
    issueProject: vi.fn(async (key: string) => projectOf(key)),
    search: vi.fn(async () => ({ issues: [], truncated: false })),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({
      id: "10001",
      url: "https://your-site.atlassian.net/browse/PROJ-1?focusedCommentId=10001",
    })),
    editComment: vi.fn(async () => undefined),
    readComment: vi.fn(async () => ({ authorId: "bot-1", body: "Earlier text\n\nwardby agent a1" })),
    issueUrl: (k: string) => `https://your-site.atlassian.net/browse/${k}`,
  };
}

function ctx(t: IssueTracker, links: IssueProjectLink[] = [WRITE_LINK, READ_LINK]): IssueToolContext {
  return {
    agentId: "a1",
    links,
    trackers: { jira: t },
    currentLink: vi.fn(async (projectKey: string) => links.find((l) => l.projectKey === projectKey) ?? null),
  };
}

const call = async (name: string, args: unknown, c: IssueToolContext) =>
  JSON.parse(await handleIssueTrackerTool(name, typeof args === "string" ? args : JSON.stringify(args), c));

describe("ISSUE_TRACKER_TOOL_DEFS", () => {
  it("defines the four jira_* tools and tells the model how it posts", () => {
    expect([...ISSUE_TRACKER_TOOL_NAMES].sort()).toEqual([
      "jira_comment",
      "jira_edit_own_comment",
      "jira_get_issue",
      "jira_search",
    ]);
    const comment = ISSUE_TRACKER_TOOL_DEFS.find((t) => t.name === "jira_comment")!;
    expect(comment.description).toMatch(/service account/);
    expect(comment.description).toMatch(/Markdown/);
    expect(comment.description).toMatch(/@/);
  });
});

describe("handleIssueTrackerTool", () => {
  it("refuses an issue in a project this agent is not linked to", async () => {
    const t = tracker();
    expect(await call("jira_get_issue", { issueKey: "OTHER-1" }, ctx(t))).toMatchObject({
      error: "project_not_linked",
    });
    expect(t.getIssue).not.toHaveBeenCalled();
  });

  it("refuses jira_comment on a read link", async () => {
    const t = tracker();
    expect(await call("jira_comment", { issueKey: "DOCS-4", body: "hi" }, ctx(t))).toMatchObject({
      error: "write_access_required",
    });
    expect(t.comment).not.toHaveBeenCalled();
  });

  it("refuses a write tool when the link was downgraded to read since the run loaded it", async () => {
    const t = tracker();
    const c = ctx(t);
    c.currentLink = async () => ({ ...WRITE_LINK, access: "read" });
    expect(await call("jira_comment", { issueKey: "PROJ-1", body: "hi" }, c)).toMatchObject({
      error: "write_access_required",
    });
    expect(t.comment).not.toHaveBeenCalled();
  });

  it("jira_comment appends this agent's footer and applies the link's visibility role", async () => {
    const t = tracker();
    const result = await call("jira_comment", { issueKey: "PROJ-1", body: "Looks done." }, ctx(t));
    expect(t.comment).toHaveBeenCalledWith("PROJ-1", {
      markdown: "Looks done.\n\n_wardby agent a1_",
      visibilityRole: "Developers",
    });
    expect(result).toEqual({
      id: "10001",
      url: "https://your-site.atlassian.net/browse/PROJ-1?focusedCommentId=10001",
    });
  });

  it("jira_comment on a link without a visibility role posts publicly", async () => {
    const t = tracker();
    await call(
      "jira_comment",
      { issueKey: "PROJ-1", body: "x" },
      ctx(t, [{ ...WRITE_LINK, commentVisibilityRole: null }]),
    );
    expect(t.comment).toHaveBeenCalledWith("PROJ-1", { markdown: "x\n\n_wardby agent a1_" });
  });

  it("jira_get_issue passes the agent marker and a default comment cap", async () => {
    const t = tracker();
    expect(await call("jira_get_issue", { issueKey: "PROJ-12" }, ctx(t))).toEqual({
      key: "PROJ-12",
      projectKey: "PROJ",
      summary: "S",
    });
    expect(t.getIssue).toHaveBeenCalledWith("PROJ-12", { maxComments: 10, agentMarker: "a1" });
  });

  it("jira_search scopes the JQL to the linked projects", async () => {
    const t = tracker();
    await call("jira_search", { jql: "status = Done" }, ctx(t, [WRITE_LINK]));
    expect(t.search).toHaveBeenCalledWith("project in (PROJ) AND (status = Done)", { maxResults: 20 });
  });

  it("jira_search leaves out a project unlinked since the run loaded it, and refuses when none is left", async () => {
    const t = tracker();
    const c = ctx(t);
    c.currentLink = async (key) => (key === "PROJ" ? WRITE_LINK : null);
    await call("jira_search", { jql: "status = Done", maxResults: 5 }, c);
    expect(t.search).toHaveBeenCalledWith("project in (PROJ) AND (status = Done)", { maxResults: 5 });
    c.currentLink = async () => null;
    expect(await call("jira_search", { jql: "status = Done" }, c)).toMatchObject({ error: "project_not_linked" });
    expect(t.search).toHaveBeenCalledTimes(1);
  });

  it("jira_search refuses JQL that could break out of the project scope", async () => {
    const t = tracker();
    for (const jql of [
      "status = Done) OR (project = SECRET",
      "status = Done) OR project = SECRET OR (x = y",
      "a = b)",
    ]) {
      expect(await call("jira_search", { jql }, ctx(t)), jql).toMatchObject({ error: "invalid_jql" });
    }
    expect(t.search).not.toHaveBeenCalled();
  });

  it("jira_edit_own_comment refuses someone else's comment", async () => {
    const t = tracker();
    vi.mocked(t.readComment).mockResolvedValue({ authorId: "human-1", body: "mine\n\nwardby agent a1" });
    expect(
      await call("jira_edit_own_comment", { issueKey: "PROJ-1", commentId: "10001", body: "new" }, ctx(t)),
    ).toMatchObject({ error: "not_own_comment" });
    expect(t.editComment).not.toHaveBeenCalled();
  });

  it("jira_edit_own_comment refuses a bot comment without this agent's footer", async () => {
    const t = tracker();
    for (const body of ["status comment\n\nwardby agent other", "wardby agent a1 is quoted here\n\nbut not last"]) {
      vi.mocked(t.readComment).mockResolvedValue({ authorId: "bot-1", body });
      expect(
        await call("jira_edit_own_comment", { issueKey: "PROJ-1", commentId: "10001", body: "new" }, ctx(t)),
        body,
      ).toMatchObject({ error: "not_own_comment" });
    }
    expect(t.editComment).not.toHaveBeenCalled();
  });

  it("jira_edit_own_comment re-appends the footer to its own comment", async () => {
    const t = tracker();
    const result = await call(
      "jira_edit_own_comment",
      { issueKey: "PROJ-1", commentId: "10001", body: "Updated." },
      ctx(t),
    );
    expect(t.readComment).toHaveBeenCalledWith("PROJ-1", "10001");
    expect(t.editComment).toHaveBeenCalledWith("PROJ-1", "10001", { markdown: "Updated.\n\n_wardby agent a1_" });
    expect(result).toEqual({
      id: "10001",
      url: "https://your-site.atlassian.net/browse/PROJ-1?focusedCommentId=10001",
    });
  });

  it("jira_edit_own_comment reports a missing comment as not found", async () => {
    const t = tracker();
    vi.mocked(t.readComment).mockResolvedValue(null);
    expect(
      await call("jira_edit_own_comment", { issueKey: "PROJ-1", commentId: "1", body: "x" }, ctx(t)),
    ).toMatchObject({ error: "tracker_not_found" });
  });

  it("refuses a project unlinked while the run was under way", async () => {
    const t = tracker();
    const c = ctx(t);
    c.currentLink = async () => null;
    expect(await call("jira_get_issue", { issueKey: "PROJ-1" }, c)).toMatchObject({ error: "project_not_linked" });
    expect(await call("jira_comment", { issueKey: "PROJ-1", body: "x" }, c)).toMatchObject({
      error: "project_not_linked",
    });
    expect(t.getIssue).not.toHaveBeenCalled();
    expect(t.comment).not.toHaveBeenCalled();
  });

  it("returns tracker errors as JSON results", async () => {
    const t = tracker();
    vi.mocked(t.getIssue).mockRejectedValue(new IssueTrackerError("tracker_not_found", "Issue does not exist."));
    expect(await call("jira_get_issue", { issueKey: "PROJ-9" }, ctx(t))).toEqual({
      error: "tracker_not_found",
      message: "Issue does not exist.",
    });
    vi.mocked(t.getIssue).mockRejectedValue(new Error("socket hang up"));
    expect(await call("jira_get_issue", { issueKey: "PROJ-9" }, ctx(t))).toMatchObject({ error: "tracker_api_error" });
  });

  it("refuses when the live link check itself fails", async () => {
    const t = tracker();
    const c = ctx(t);
    c.currentLink = async () => {
      throw new Error("db down");
    };
    expect(await call("jira_get_issue", { issueKey: "PROJ-1" }, c)).toMatchObject({ error: "tracker_api_error" });
    expect(t.getIssue).not.toHaveBeenCalled();
  });

  it("rejects bad JSON, bad arguments, and unknown extra fields without throwing", async () => {
    const t = tracker();
    expect(await call("jira_get_issue", "{not json", ctx(t))).toMatchObject({ error: "invalid_arguments_json" });
    expect(await call("jira_get_issue", { issueKey: "proj-1" }, ctx(t))).toMatchObject({ error: "invalid_arguments" });
    expect(await call("jira_get_issue", { issueKey: "PROJ-1", extra: 1 }, ctx(t))).toMatchObject({
      error: "invalid_arguments",
    });
    expect(await call("jira_get_issue", { issueKey: "PROJ-1", maxComments: 51 }, ctx(t))).toMatchObject({
      error: "invalid_arguments",
    });
    expect(
      await call("jira_edit_own_comment", { issueKey: "PROJ-1", commentId: "abc", body: "x" }, ctx(t)),
    ).toMatchObject({ error: "invalid_arguments" });
    expect(await call("jira_comment", { issueKey: "PROJ-1", body: "" }, ctx(t))).toMatchObject({
      error: "invalid_arguments",
    });
    expect(t.getIssue).not.toHaveBeenCalled();
  });

  it("reports tracker_not_configured when the link's provider has no tracker", async () => {
    const c = ctx(tracker());
    c.trackers = {};
    expect(await call("jira_get_issue", { issueKey: "PROJ-1" }, c)).toMatchObject({ error: "tracker_not_configured" });
  });
});

describe("jira_* project boundary", () => {
  const hit = (key: string) => ({ key, summary: "s", status: "Open", issueType: "Task", updated: "", url: "u" });

  it("jira_search refuses backslash escapes outside quoted strings (scanner/lexer desync)", async () => {
    const t = tracker();
    for (const jql of [
      'summary ~ a\\" ) OR project = SECRET OR ( summary ~ "b\\""',
      "labels = x\\' ) OR project = SECRET OR ( labels = 'y\\''",
    ]) {
      expect(await call("jira_search", { jql }, ctx(t)), jql).toMatchObject({ error: "invalid_jql" });
    }
    expect(t.search).not.toHaveBeenCalled();
  });

  it("jira_search refuses issueFunction in any case", async () => {
    const t = tracker();
    for (const jql of ['issueFunction in linkedIssuesOf("project = SECRET")', "ISSUEFUNCTION in x()"]) {
      expect(await call("jira_search", { jql }, ctx(t)), jql).toMatchObject({ error: "invalid_jql" });
    }
    expect(t.search).not.toHaveBeenCalled();
  });

  it("jira_search drops results outside the live-linked projects and keeps the tracker's truncation flag", async () => {
    const t = tracker();
    vi.mocked(t.search).mockResolvedValue({
      issues: [hit("PROJ-1"), hit("SECRET-9"), hit("DOCS-2")],
      truncated: false,
    });
    const c = ctx(t);
    c.currentLink = async (key) => (key === "PROJ" ? WRITE_LINK : null);
    expect(await call("jira_search", { jql: "status = Open" }, c)).toEqual({
      issues: [hit("PROJ-1")],
      truncated: false,
    });
    vi.mocked(t.search).mockResolvedValue({ issues: [hit("SECRET-9")], truncated: true });
    expect(await call("jira_search", { jql: "status = Open" }, c)).toEqual({ issues: [], truncated: true });
  });

  it("jira_search leaves a malformed project key out of the JQL", async () => {
    const t = tracker();
    const bad: IssueProjectLink = { ...READ_LINK, projectKey: "X) OR (1=1" };
    const c = ctx(t, [WRITE_LINK, bad]);
    await call("jira_search", { jql: "status = Done" }, c);
    expect(t.search).toHaveBeenCalledWith("project in (PROJ) AND (status = Done)", { maxResults: 20 });
  });

  it("jira_get_issue refuses a key in a linked project that resolves to an unlinked one, without returning it", async () => {
    const t = tracker();
    vi.mocked(t.getIssue).mockResolvedValue({ key: "SECRET-3", projectKey: "SECRET", summary: "classified" } as never);
    const result = await handleIssueTrackerTool("jira_get_issue", JSON.stringify({ issueKey: "PROJ-7" }), ctx(t));
    expect(JSON.parse(result)).toMatchObject({ error: "project_not_linked" });
    expect(result).not.toContain("classified");
  });

  it("jira_get_issue allows a moved issue whose new project is also linked", async () => {
    const t = tracker();
    vi.mocked(t.getIssue).mockResolvedValue({ key: "DOCS-3", projectKey: "DOCS", summary: "S" } as never);
    expect(await call("jira_get_issue", { issueKey: "PROJ-7" }, ctx(t))).toMatchObject({ key: "DOCS-3" });
  });

  it("jira_comment and jira_edit_own_comment authorize the project the key resolves to, before writing", async () => {
    const t = tracker();
    vi.mocked(t.issueProject).mockResolvedValue("SECRET");
    expect(await call("jira_comment", { issueKey: "PROJ-7", body: "x" }, ctx(t))).toMatchObject({
      error: "project_not_linked",
    });
    expect(
      await call("jira_edit_own_comment", { issueKey: "PROJ-7", commentId: "10001", body: "x" }, ctx(t)),
    ).toMatchObject({ error: "project_not_linked" });
    // Resolves to a linked but read-only project.
    vi.mocked(t.issueProject).mockResolvedValue("DOCS");
    expect(await call("jira_comment", { issueKey: "PROJ-7", body: "x" }, ctx(t))).toMatchObject({
      error: "write_access_required",
    });
    expect(t.comment).not.toHaveBeenCalled();
    expect(t.editComment).not.toHaveBeenCalled();
    expect(t.readComment).not.toHaveBeenCalled();
  });
});

describe("scopeJql", () => {
  it("wraps the filter and keeps a trailing ORDER BY outside it", () => {
    expect(scopeJql(["PROJ", "OPS"], "status = Done ORDER BY updated DESC")).toEqual({
      jql: "project in (PROJ, OPS) AND (status = Done) ORDER BY updated DESC",
    });
    expect(scopeJql(["PROJ"], "ORDER BY created")).toEqual({ jql: "project in (PROJ) ORDER BY created" });
  });

  it("ignores parentheses and ORDER BY inside quoted strings", () => {
    expect(scopeJql(["PROJ"], 'summary ~ "a) OR (b order by c"')).toEqual({
      jql: 'project in (PROJ) AND (summary ~ "a) OR (b order by c")',
    });
    expect(scopeJql(["PROJ"], 'summary ~ "say \\"hi\\""')).toEqual({
      jql: 'project in (PROJ) AND (summary ~ "say \\"hi\\"")',
    });
  });

  it("refuses unbalanced parentheses, unterminated strings, and unquoted backslashes", () => {
    for (const jql of ["a = b) OR (c = d", "(a = b", 'summary ~ "open', "a = b ORDER BY (x", "a = b\\ c"]) {
      expect(scopeJql(["PROJ"], jql), jql).toHaveProperty("error");
    }
  });
});
