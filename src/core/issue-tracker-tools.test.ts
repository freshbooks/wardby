import { describe, expect, it, vi } from "vitest";
import { IssueTrackerError, projectOf, type IssueTracker } from "../providers/issue-tracker/types.js";
import { fileIssue, type FileIssueInput, type FileIssueResult } from "./issue-dedupe.js";
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
  allowedTransitions: ["In Progress", "Done"],
  writableFields: ["labels", "priority", "customfield_10010"],
  allowedLinkTypes: ["Blocks", "Duplicate"],
  creatableIssueTypes: ["Bug", "Task"],
  maxNewIssuesPerRun: null,
};
const READ_LINK: IssueProjectLink = {
  provider: "jira",
  projectKey: "DOCS",
  access: "read",
  commentVisibilityRole: null,
  allowedTransitions: [],
  writableFields: [],
  allowedLinkTypes: [],
  creatableIssueTypes: [],
  maxNewIssuesPerRun: null,
};

function tracker(): IssueTracker {
  return {
    provider: "jira",
    botAccountId: vi.fn(async () => "bot-1"),
    createMeta: vi.fn(),
    fieldMeta: vi.fn(),
    createIssue: vi.fn(),
    readAttachmentText: vi.fn(),
    identity: vi.fn(async () => ({ accountId: "bot-1", displayName: "wardby", accountType: "app" })),
    transitions: vi.fn(),
    transitionTo: vi.fn(),
    editableFields: vi.fn(),
    editFields: vi.fn(),
    linkTypes: vi.fn(),
    linkIssues: vi.fn(),
    addRemoteLink: vi.fn(),
    getProperty: vi.fn(),
    setProperty: vi.fn(),
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
  it("defines the jira_* tools and tells the model how it posts", () => {
    expect([...ISSUE_TRACKER_TOOL_NAMES].sort()).toEqual([
      "jira_comment",
      "jira_create_issue",
      "jira_edit_own_comment",
      "jira_get_issue",
      "jira_get_property",
      "jira_link_issues",
      "jira_list_transitions",
      "jira_read_attachment",
      "jira_search",
      "jira_set_property",
      "jira_transition",
      "jira_update_fields",
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

describe("jira_* write tools (transitions, fields, links, properties)", () => {
  const OPS: IssueProjectLink = {
    provider: "jira",
    projectKey: "OPS",
    access: "write",
    commentVisibilityRole: null,
    allowedTransitions: [],
    writableFields: [],
    allowedLinkTypes: [],
    creatableIssueTypes: [],
    maxNewIssuesPerRun: null,
  };
  const def = (name: string) => ISSUE_TRACKER_TOOL_DEFS.find((t) => t.name === name)!;
  const TRANSITIONS = [
    { id: "11", name: "Start", toStatus: "In Progress", toCategory: "indeterminate" },
    { id: "21", name: "Close", toStatus: "Done", toCategory: "done" },
    { id: "31", name: "Won't do", toStatus: "Rejected", toCategory: "done" },
  ];

  it("descriptions name the governing allowlist, the service account, and label visibility", () => {
    expect(def("jira_list_transitions").description).toMatch(/allowedTransitions/);
    expect(def("jira_list_transitions").description).toMatch(/notAllowed/);
    expect(def("jira_transition").description).toMatch(/allowedTransitions/);
    expect(def("jira_transition").description).toMatch(/service account/);
    expect(def("jira_update_fields").description).toMatch(/writableFields/);
    expect(def("jira_update_fields").description).toMatch(/visible to everyone/);
    expect(def("jira_update_fields").description).toMatch(/service account/);
    expect(def("jira_link_issues").description).toMatch(/both issues/i);
    expect(def("jira_link_issues").description).toMatch(/allowedLinkTypes/);
    expect(def("jira_set_property").description).toMatch(/this agent/);
  });

  describe("jira_list_transitions", () => {
    it("returns only allowlisted targets (case-insensitive) and works on the link's live allowlist", async () => {
      const t = tracker();
      vi.mocked(t.transitions).mockResolvedValue(TRANSITIONS);
      const c = ctx(t);
      c.currentLink = async (k) => (k === "PROJ" ? { ...WRITE_LINK, allowedTransitions: ["done"] } : null);
      expect(await call("jira_list_transitions", { issueKey: "PROJ-1" }, c)).toEqual({
        transitions: [{ name: "Close", toStatus: "Done", toCategory: "done" }],
        notAllowed: ["In Progress", "Rejected"],
        note: expect.stringMatching(/allowedTransitions.*not the Jira workflow/),
      });
    });

    it("has an empty notAllowed and no note when everything offered is allowlisted", async () => {
      const t = tracker();
      vi.mocked(t.transitions).mockResolvedValue(TRANSITIONS);
      const c = ctx(t);
      c.currentLink = async (k) =>
        k === "PROJ" ? { ...WRITE_LINK, allowedTransitions: ["In Progress", "Done", "Rejected"] } : null;
      const r = (await call("jira_list_transitions", { issueKey: "PROJ-1" }, c)) as Record<string, unknown>;
      expect(r.notAllowed).toEqual([]);
      expect(r).not.toHaveProperty("note");
      expect(r.transitions).toHaveLength(3);
    });

    it("fails closed on an empty allowlist without calling Jira", async () => {
      const t = tracker();
      expect(await call("jira_list_transitions", { issueKey: "DOCS-1" }, ctx(t))).toMatchObject({
        error: "transition_not_allowed",
      });
      expect(t.transitions).not.toHaveBeenCalled();
    });

    it("refuses a key that resolves to an unlinked project", async () => {
      const t = tracker();
      vi.mocked(t.issueProject).mockResolvedValue("SECRET");
      expect(await call("jira_list_transitions", { issueKey: "PROJ-1" }, ctx(t))).toMatchObject({
        error: "project_not_linked",
      });
      expect(t.transitions).not.toHaveBeenCalled();
    });
  });

  describe("jira_transition", () => {
    it("transitions to an allowlisted status", async () => {
      const t = tracker();
      vi.mocked(t.transitionTo).mockResolvedValue({ transitionId: "21", toStatus: "Done" });
      expect(await call("jira_transition", { issueKey: "PROJ-1", toStatus: "done" }, ctx(t))).toEqual({
        issueKey: "PROJ-1",
        toStatus: "Done",
      });
      expect(t.transitionTo).toHaveBeenCalledWith("PROJ-1", "done");
    });

    it("refuses a target outside the allowlist before calling Jira", async () => {
      const t = tracker();
      expect(await call("jira_transition", { issueKey: "PROJ-1", toStatus: "Rejected" }, ctx(t))).toMatchObject({
        error: "transition_not_allowed",
      });
      expect(t.transitionTo).not.toHaveBeenCalled();
      expect(t.issueProject).not.toHaveBeenCalled();
    });

    it("fails closed on an empty allowlist, even with write access", async () => {
      const t = tracker();
      expect(
        await call("jira_transition", { issueKey: "OPS-1", toStatus: "Done" }, ctx(t, [WRITE_LINK, OPS])),
      ).toMatchObject({ error: "transition_not_allowed" });
      expect(t.transitionTo).not.toHaveBeenCalled();
    });

    it("refuses on a read link", async () => {
      const t = tracker();
      const c = ctx(t, [{ ...READ_LINK, allowedTransitions: ["Done"] }]);
      expect(await call("jira_transition", { issueKey: "DOCS-1", toStatus: "Done" }, c)).toMatchObject({
        error: "write_access_required",
      });
      expect(t.transitionTo).not.toHaveBeenCalled();
    });

    it("authorizes the resolved project, and uses the resolved link's allowlist", async () => {
      const t = tracker();
      vi.mocked(t.issueProject).mockResolvedValue("SECRET");
      expect(await call("jira_transition", { issueKey: "PROJ-1", toStatus: "Done" }, ctx(t))).toMatchObject({
        error: "project_not_linked",
      });
      // Resolves to OPS: write, but its allowlist is empty.
      vi.mocked(t.issueProject).mockResolvedValue("OPS");
      expect(
        await call("jira_transition", { issueKey: "PROJ-1", toStatus: "Done" }, ctx(t, [WRITE_LINK, OPS])),
      ).toMatchObject({ error: "transition_not_allowed" });
      expect(t.transitionTo).not.toHaveBeenCalled();
    });

    it("maps tracker errors and rejects a bad toStatus", async () => {
      const t = tracker();
      vi.mocked(t.transitionTo).mockRejectedValue(new IssueTrackerError("tracker_invalid_request", "No such move."));
      expect(await call("jira_transition", { issueKey: "PROJ-1", toStatus: "Done" }, ctx(t))).toEqual({
        error: "tracker_invalid_request",
        message: "No such move.",
      });
      expect(await call("jira_transition", { issueKey: "PROJ-1", toStatus: "x".repeat(101) }, ctx(t))).toMatchObject({
        error: "invalid_arguments",
      });
    });
  });

  describe("jira_update_fields", () => {
    const editable = ["labels", "priority", "components", "customfield_10010", "summary"];

    it("edits allowlisted, editable fields", async () => {
      const t = tracker();
      vi.mocked(t.editableFields).mockResolvedValue(editable);
      const fields = { labels: ["triaged", "needs-info"], priority: "High", customfield_10010: { value: "Red" } };
      expect(await call("jira_update_fields", { issueKey: "PROJ-1", fields }, ctx(t))).toEqual({
        issueKey: "PROJ-1",
        updated: ["labels", "priority", "customfield_10010"],
      });
      expect(t.editFields).toHaveBeenCalledWith("PROJ-1", fields);
    });

    it("refuses a field outside writableFields before calling Jira", async () => {
      const t = tracker();
      vi.mocked(t.editableFields).mockResolvedValue(editable);
      expect(
        await call("jira_update_fields", { issueKey: "PROJ-1", fields: { components: ["api"] } }, ctx(t)),
      ).toMatchObject({ error: "field_not_allowed" });
      expect(t.editableFields).not.toHaveBeenCalled();
      expect(t.editFields).not.toHaveBeenCalled();
    });

    it("fails closed on an empty writableFields, even with write access", async () => {
      const t = tracker();
      expect(
        await call("jira_update_fields", { issueKey: "OPS-1", fields: { labels: ["x"] } }, ctx(t, [WRITE_LINK, OPS])),
      ).toMatchObject({ error: "field_not_allowed" });
      expect(t.editFields).not.toHaveBeenCalled();
    });

    it("refuses a field the service account cannot edit on this issue", async () => {
      const t = tracker();
      vi.mocked(t.editableFields).mockResolvedValue(["labels"]);
      expect(
        await call("jira_update_fields", { issueKey: "PROJ-1", fields: { labels: ["a"], priority: "Low" } }, ctx(t)),
      ).toMatchObject({ error: "field_not_editable" });
      expect(t.editFields).not.toHaveBeenCalled();
    });

    it("refuses on a read link and on a key resolving to an unlinked or read-only project", async () => {
      const t = tracker();
      const read = ctx(t, [{ ...READ_LINK, writableFields: ["labels"] }]);
      expect(await call("jira_update_fields", { issueKey: "DOCS-1", fields: { labels: ["a"] } }, read)).toMatchObject({
        error: "write_access_required",
      });
      vi.mocked(t.issueProject).mockResolvedValue("SECRET");
      expect(await call("jira_update_fields", { issueKey: "PROJ-1", fields: { labels: ["a"] } }, ctx(t))).toMatchObject(
        { error: "project_not_linked" },
      );
      vi.mocked(t.issueProject).mockResolvedValue("DOCS");
      expect(await call("jira_update_fields", { issueKey: "PROJ-1", fields: { labels: ["a"] } }, ctx(t))).toMatchObject(
        { error: "write_access_required" },
      );
      expect(t.editFields).not.toHaveBeenCalled();
    });

    it("validates value shapes per field", async () => {
      const t = tracker();
      vi.mocked(t.editableFields).mockResolvedValue(editable);
      const c = ctx(t, [{ ...WRITE_LINK, writableFields: ["labels", "components", "priority", "customfield_10010"] }]);
      for (const fields of [
        {},
        { labels: ["has space"] },
        { labels: [""] },
        { labels: ["x".repeat(256)] },
        { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) },
        { labels: "notarray" },
        { components: Array.from({ length: 21 }, (_, i) => `c${i}`) },
        { priority: "" },
        { priority: "x".repeat(101) },
        { customfield_10010: "x".repeat(8001) },
        { summary: "not a supported field" },
        { customfield_abc: 1 },
      ]) {
        expect(
          await call("jira_update_fields", { issueKey: "PROJ-1", fields }, c),
          JSON.stringify(fields).slice(0, 60),
        ).toMatchObject({
          error: "invalid_arguments",
        });
      }
      expect(t.editFields).not.toHaveBeenCalled();
    });

    it("maps tracker errors", async () => {
      const t = tracker();
      vi.mocked(t.editableFields).mockResolvedValue(editable);
      vi.mocked(t.editFields).mockRejectedValue(new IssueTrackerError("tracker_permission_denied", "Nope."));
      expect(await call("jira_update_fields", { issueKey: "PROJ-1", fields: { labels: ["a"] } }, ctx(t))).toEqual({
        error: "tracker_permission_denied",
        message: "Nope.",
      });
    });
  });

  describe("jira_link_issues", () => {
    const TYPES = [
      { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      { name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
      { name: "Relates", inward: "relates to", outward: "relates to" },
    ];
    /** A second writable project whose allowlist names "blocks" in another case. */
    const TEAM: IssueProjectLink = {
      provider: "jira",
      projectKey: "TEAM",
      access: "write",
      commentVisibilityRole: null,
      allowedTransitions: [],
      writableFields: [],
      allowedLinkTypes: ["blocks"],
      creatableIssueTypes: [],
      maxNewIssuesPerRun: null,
    };
    const links = () => [WRITE_LINK, READ_LINK, TEAM, OPS];

    it("links issues when both projects are writable and both allowlist the type (case-insensitive)", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      expect(
        await call(
          "jira_link_issues",
          { type: "BLOCKS", inwardIssue: "TEAM-2", outwardIssue: "PROJ-1" },
          ctx(t, links()),
        ),
      ).toEqual({ type: "Blocks", inwardIssue: "TEAM-2", outwardIssue: "PROJ-1" });
      expect(t.linkIssues).toHaveBeenCalledWith({ type: "Blocks", inwardKey: "TEAM-2", outwardKey: "PROJ-1" });
    });

    it("refuses when a project's allowlist is empty, without calling Jira", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      for (const [inwardIssue, outwardIssue] of [
        ["OPS-2", "PROJ-1"],
        ["PROJ-1", "OPS-2"],
      ]) {
        expect(
          await call("jira_link_issues", { type: "Blocks", inwardIssue, outwardIssue }, ctx(t, links())),
        ).toMatchObject({ error: "link_type_not_allowed" });
      }
      expect(t.issueProject).not.toHaveBeenCalled();
      expect(t.linkTypes).not.toHaveBeenCalled();
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("refuses a type that is not in both projects' allowlists", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      // Relates is in neither; Duplicate is in PROJ's but not TEAM's.
      for (const type of ["Relates", "Duplicate"]) {
        const result = await call(
          "jira_link_issues",
          { type, inwardIssue: "TEAM-2", outwardIssue: "PROJ-1" },
          ctx(t, links()),
        );
        expect(result).toMatchObject({ error: "link_type_not_allowed" });
      }
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("applies the resolved project's allowlist too", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      // TEAM-2 was moved: it now lives in OPS, which is writable but allowlists nothing.
      vi.mocked(t.issueProject).mockImplementation(async (key) => (key === "TEAM-2" ? "OPS" : projectOf(key)));
      expect(
        await call(
          "jira_link_issues",
          { type: "Blocks", inwardIssue: "TEAM-2", outwardIssue: "PROJ-1" },
          ctx(t, links()),
        ),
      ).toMatchObject({ error: "link_type_not_allowed" });
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("applies the live link's allowlist, not the pinned one", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      const c = ctx(t, links());
      c.currentLink = async (k) =>
        k === "TEAM" ? { ...TEAM, allowedLinkTypes: [] } : (links().find((l) => l.projectKey === k) ?? null);
      expect(
        await call("jira_link_issues", { type: "Blocks", inwardIssue: "TEAM-2", outwardIssue: "PROJ-1" }, c),
      ).toMatchObject({ error: "link_type_not_allowed" });
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("refuses when either issue's project is read-only", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      const readWithTypes = { ...READ_LINK, allowedLinkTypes: ["Blocks"] };
      for (const [inwardIssue, outwardIssue] of [
        ["DOCS-2", "PROJ-1"],
        ["PROJ-1", "DOCS-2"],
      ]) {
        expect(
          await call(
            "jira_link_issues",
            { type: "Blocks", inwardIssue, outwardIssue },
            ctx(t, [WRITE_LINK, readWithTypes]),
          ),
        ).toMatchObject({ error: "write_access_required" });
      }
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("refuses when either issue is in an unlinked project", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      for (const [inwardIssue, outwardIssue] of [
        ["SECRET-1", "PROJ-1"],
        ["PROJ-1", "SECRET-1"],
      ]) {
        expect(
          await call("jira_link_issues", { type: "Blocks", inwardIssue, outwardIssue }, ctx(t, links())),
        ).toMatchObject({ error: "project_not_linked" });
      }
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("refuses when the inward issue resolves to an unlinked project, without writing", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      vi.mocked(t.issueProject).mockImplementation(async (key) => (key === "TEAM-2" ? "SECRET" : projectOf(key)));
      expect(
        await call(
          "jira_link_issues",
          { type: "Blocks", inwardIssue: "TEAM-2", outwardIssue: "PROJ-1" },
          ctx(t, links()),
        ),
      ).toMatchObject({ error: "project_not_linked" });
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("refuses when the inward issue resolves to a read-only project", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      vi.mocked(t.issueProject).mockImplementation(async (key) => (key === "TEAM-2" ? "DOCS" : projectOf(key)));
      expect(
        await call(
          "jira_link_issues",
          { type: "Blocks", inwardIssue: "TEAM-2", outwardIssue: "PROJ-1" },
          ctx(t, links()),
        ),
      ).toMatchObject({ error: "write_access_required" });
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("refuses when the outward issue resolves to a read-only project", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      vi.mocked(t.issueProject).mockImplementation(async (key) => (key === "PROJ-1" ? "DOCS" : projectOf(key)));
      expect(
        await call(
          "jira_link_issues",
          { type: "Blocks", inwardIssue: "TEAM-2", outwardIssue: "PROJ-1" },
          ctx(t, links()),
        ),
      ).toMatchObject({ error: "write_access_required" });
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("refuses linking an issue to itself", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue(TYPES);
      expect(
        await call("jira_link_issues", { type: "Blocks", inwardIssue: "PROJ-1", outwardIssue: "PROJ-1" }, ctx(t)),
      ).toMatchObject({ error: "invalid_arguments" });
      expect(t.linkIssues).not.toHaveBeenCalled();
    });

    it("refuses an allowlisted type the Jira site does not have, naming the available ones", async () => {
      const t = tracker();
      vi.mocked(t.linkTypes).mockResolvedValue([TYPES[0]]);
      const result = await call(
        "jira_link_issues",
        { type: "Duplicate", inwardIssue: "PROJ-2", outwardIssue: "PROJ-1" },
        ctx(t, links()),
      );
      expect(result).toMatchObject({ error: "invalid_link_type" });
      expect(result.message).toContain("Blocks");
      expect(t.linkIssues).not.toHaveBeenCalled();
    });
  });

  describe("jira_get_property / jira_set_property", () => {
    it("namespaces the property key as wardby.<agentId>.<property>", async () => {
      const t = tracker();
      vi.mocked(t.getProperty).mockResolvedValue({ n: 1 });
      expect(await call("jira_get_property", { issueKey: "DOCS-1", property: "triage.state" }, ctx(t))).toEqual({
        property: "triage.state",
        value: { n: 1 },
      });
      expect(t.getProperty).toHaveBeenCalledWith("DOCS-1", "wardby.a1.triage.state");
      expect(
        await call("jira_set_property", { issueKey: "PROJ-1", property: "triage.state", value: { n: 2 } }, ctx(t)),
      ).toEqual({ property: "triage.state", ok: true });
      expect(t.setProperty).toHaveBeenCalledWith("PROJ-1", "wardby.a1.triage.state", { n: 2 });
    });

    it("reports a missing property as a null value", async () => {
      const t = tracker();
      vi.mocked(t.getProperty).mockResolvedValue(null);
      expect(await call("jira_get_property", { issueKey: "PROJ-1", property: "x" }, ctx(t))).toEqual({
        property: "x",
        value: null,
      });
    });

    it("rejects property names that could escape the namespace", async () => {
      const t = tracker();
      for (const property of [
        "",
        ".x",
        "a..b",
        "A",
        "x/y",
        "x y",
        "../other",
        "x".repeat(65),
        "wardby.b2.x".toUpperCase(),
      ]) {
        expect(await call("jira_get_property", { issueKey: "PROJ-1", property }, ctx(t)), property).toMatchObject({
          error: "invalid_arguments",
        });
        expect(
          await call("jira_set_property", { issueKey: "PROJ-1", property, value: 1 }, ctx(t)),
          property,
        ).toMatchObject({ error: "invalid_arguments" });
      }
      expect(t.getProperty).not.toHaveBeenCalled();
      expect(t.setProperty).not.toHaveBeenCalled();
    });

    it("caps the serialised value and requires one", async () => {
      const t = tracker();
      expect(
        await call("jira_set_property", { issueKey: "PROJ-1", property: "x", value: "y".repeat(8000) }, ctx(t)),
      ).toMatchObject({ error: "invalid_arguments" });
      expect(await call("jira_set_property", { issueKey: "PROJ-1", property: "x" }, ctx(t))).toMatchObject({
        error: "invalid_arguments",
      });
      expect(t.setProperty).not.toHaveBeenCalled();
    });

    it("set needs a write link; both authorize the resolved project", async () => {
      const t = tracker();
      expect(await call("jira_set_property", { issueKey: "DOCS-1", property: "x", value: 1 }, ctx(t))).toMatchObject({
        error: "write_access_required",
      });
      vi.mocked(t.issueProject).mockResolvedValue("SECRET");
      expect(await call("jira_get_property", { issueKey: "PROJ-1", property: "x" }, ctx(t))).toMatchObject({
        error: "project_not_linked",
      });
      expect(await call("jira_set_property", { issueKey: "PROJ-1", property: "x", value: 1 }, ctx(t))).toMatchObject({
        error: "project_not_linked",
      });
      expect(t.getProperty).not.toHaveBeenCalled();
      expect(t.setProperty).not.toHaveBeenCalled();
    });

    it("maps tracker errors", async () => {
      const t = tracker();
      vi.mocked(t.setProperty).mockRejectedValue(new IssueTrackerError("tracker_rate_limited", "Slow down."));
      expect(await call("jira_set_property", { issueKey: "PROJ-1", property: "x", value: 1 }, ctx(t))).toEqual({
        error: "tracker_rate_limited",
        message: "Slow down.",
      });
    });
  });
});

describe("jira_create_issue", () => {
  const def = ISSUE_TRACKER_TOOL_DEFS.find((t) => t.name === "jira_create_issue")!;
  const ARGS = { projectKey: "PROJ", issueType: "Bug", summary: "Login fails", description: "Steps: ..." };

  function creating(t: IssueTracker, links: IssueProjectLink[] = [WRITE_LINK, READ_LINK], recorded = 0) {
    const c = ctx(t, links);
    const file = vi.fn(async (input: FileIssueInput): Promise<FileIssueResult> =>
      fileIssue({ db: {} as never }, input),
    );
    const recordedCreates = vi.fn(async (_projectKey: string) => recorded);
    c.creation = { runId: "run-1", counters: new Map(), fileIssue: file, recordedCreates };
    return { c, file, recordedCreates };
  }
  function creatingTracker(): IssueTracker {
    const t = tracker();
    let n = 0;
    vi.mocked(t.createIssue).mockImplementation(async () => {
      n++;
      return { key: `PROJ-${100 + n}`, url: `https://your-site.atlassian.net/browse/PROJ-${100 + n}` };
    });
    return t;
  }

  it("describes the allowlist, the cap, fingerprints, and untrusted text", () => {
    expect(def.description).toMatch(/creatableIssueTypes/);
    expect(def.description).toMatch(/maxNewIssuesPerRun/);
    expect(def.description).toMatch(/fingerprint/i);
    expect(def.description).toMatch(/secret/i);
    expect(def.description).toMatch(/writableFields/);
  });

  it("creates with the agent footer and a created-by property, and reports the outcome", async () => {
    const t = creatingTracker();
    const { c } = creating(t);
    const result = await call(
      "jira_create_issue",
      { ...ARGS, issueType: "bug", labels: ["triage"], priority: "High", customFields: { customfield_10010: 3 } },
      c,
    );
    expect(result).toEqual({
      outcome: "created",
      issueKey: "PROJ-101",
      url: "https://your-site.atlassian.net/browse/PROJ-101",
      seenCount: 1,
    });
    expect(t.createIssue).toHaveBeenCalledWith({
      projectKey: "PROJ",
      issueType: "bug",
      summary: "Login fails",
      descriptionMarkdown: "Steps: ...\n\n_wardby agent a1_",
      labels: ["triage"],
      priority: "High",
      customFields: { customfield_10010: 3 },
      properties: { "wardby.a1.created": { runId: "run-1" } },
    });
  });

  it("refuses an unlinked project, a read link, and a link downgraded since load, without creating", async () => {
    const t = creatingTracker();
    const { c } = creating(t);
    expect(await call("jira_create_issue", { ...ARGS, projectKey: "OTHER" }, c)).toMatchObject({
      error: "project_not_linked",
    });
    expect(await call("jira_create_issue", { ...ARGS, projectKey: "DOCS" }, c)).toMatchObject({
      error: "write_access_required",
    });
    c.currentLink = async () => ({ ...WRITE_LINK, access: "read" });
    expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "write_access_required" });
    c.currentLink = async () => null;
    expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "project_not_linked" });
    expect(t.createIssue).not.toHaveBeenCalled();
  });

  it("applies the LIVE link's creatableIssueTypes and fails closed when empty", async () => {
    const t = creatingTracker();
    const { c } = creating(t);
    expect(await call("jira_create_issue", { ...ARGS, issueType: "Epic" }, c)).toMatchObject({
      error: "issue_type_not_allowed",
    });
    c.currentLink = async () => ({ ...WRITE_LINK, creatableIssueTypes: [] });
    expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "issue_type_not_allowed" });
    // A link pinned before the field existed (undefined) allows nothing either.
    c.currentLink = async () => ({ ...WRITE_LINK, creatableIssueTypes: undefined as never });
    expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "issue_type_not_allowed" });
    expect(t.createIssue).not.toHaveBeenCalled();
  });

  it("refuses custom fields outside the link's writableFields, and non-custom keys", async () => {
    const t = creatingTracker();
    const { c } = creating(t);
    expect(await call("jira_create_issue", { ...ARGS, customFields: { customfield_99999: "x" } }, c)).toMatchObject({
      error: "field_not_allowed",
    });
    expect(await call("jira_create_issue", { ...ARGS, customFields: { summary: "x" } }, c)).toMatchObject({
      error: "invalid_arguments",
    });
    expect(t.createIssue).not.toHaveBeenCalled();
  });

  it("validates lengths and unknown fields", async () => {
    const t = creatingTracker();
    const { c } = creating(t);
    for (const bad of [
      { ...ARGS, summary: "" },
      { ...ARGS, summary: "x".repeat(256) },
      { ...ARGS, description: "x".repeat(20_001) },
      { ...ARGS, fingerprint: "" },
      { ...ARGS, fingerprint: "x".repeat(201) },
      { ...ARGS, projectKey: "proj" },
      { ...ARGS, extra: 1 },
    ]) {
      expect(await call("jira_create_issue", bad, c)).toMatchObject({ error: "invalid_arguments" });
    }
    expect(t.createIssue).not.toHaveBeenCalled();
  });

  it("needs a parent in a live-linked project (read is enough), by key and by resolved project", async () => {
    const t = creatingTracker();
    const { c } = creating(t);
    expect(await call("jira_create_issue", { ...ARGS, parentKey: "SECRET-1" }, c)).toMatchObject({
      error: "project_not_linked",
    });
    vi.mocked(t.issueProject).mockResolvedValueOnce("SECRET");
    expect(await call("jira_create_issue", { ...ARGS, parentKey: "DOCS-1" }, c)).toMatchObject({
      error: "project_not_linked",
    });
    expect(t.createIssue).not.toHaveBeenCalled();
    expect(await call("jira_create_issue", { ...ARGS, parentKey: "DOCS-1" }, c)).toMatchObject({
      outcome: "created",
    });
    expect(t.createIssue).toHaveBeenCalledWith(expect.objectContaining({ parentKey: "DOCS-1" }));
  });

  it("files a fingerprinted issue through dedupe with the live link", async () => {
    const t = creatingTracker();
    const { c, file } = creating(t);
    const live = { ...WRITE_LINK, commentVisibilityRole: "Admins" };
    c.currentLink = async (k) => (k === "PROJ" ? live : null);
    file.mockResolvedValueOnce({ outcome: "seen_again", issueKey: "PROJ-7", url: "u", seenCount: 3 });
    expect(await call("jira_create_issue", { ...ARGS, fingerprint: "svc:NullPointer:Foo.bar" }, c)).toEqual({
      outcome: "seen_again",
      issueKey: "PROJ-7",
      url: "u",
      seenCount: 3,
    });
    const input = file.mock.calls[0][0];
    expect(input).toMatchObject({ agentId: "a1", runId: "run-1", link: live, fingerprint: "svc:NullPointer:Foo.bar" });
    expect(input.create).not.toHaveProperty("projectKey");
    expect(input.seenAgainMarkdown).toMatch(/wardby agent a1/);
  });

  it("returns dedupe errors as JSON", async () => {
    const t = creatingTracker();
    const { c, file } = creating(t);
    file.mockResolvedValueOnce({ error: "busy", message: "try again" });
    expect(await call("jira_create_issue", { ...ARGS, fingerprint: "f" }, c)).toEqual({
      error: "busy",
      message: "try again",
    });
    vi.mocked(t.createIssue).mockRejectedValueOnce(new IssueTrackerError("tracker_invalid_request", "need Component"));
    expect(await call("jira_create_issue", ARGS, c)).toEqual({
      error: "tracker_invalid_request",
      message: "need Component",
    });
  });

  it("refuses when the run has no creation context", async () => {
    const t = creatingTracker();
    expect(await call("jira_create_issue", ARGS, ctx(t))).toMatchObject({ error: "not_available" });
    expect(t.createIssue).not.toHaveBeenCalled();
  });

  describe("per-run cap (maxNewIssuesPerRun)", () => {
    const capped = (n: number | null): IssueProjectLink => ({ ...WRITE_LINK, maxNewIssuesPerRun: n });

    it("counts creates and regressions, not seen-again updates", async () => {
      const t = creatingTracker();
      const { c, file } = creating(t, [capped(2), READ_LINK]);
      expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ outcome: "created" });
      file.mockResolvedValueOnce({ outcome: "seen_again", issueKey: "PROJ-7", url: "u", seenCount: 2 });
      expect(await call("jira_create_issue", { ...ARGS, fingerprint: "f" }, c)).toMatchObject({
        outcome: "seen_again",
      });
      file.mockResolvedValueOnce({ outcome: "regression", issueKey: "PROJ-8", url: "u", seenCount: 1 });
      expect(await call("jira_create_issue", { ...ARGS, fingerprint: "g" }, c)).toMatchObject({
        outcome: "regression",
      });
      expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "issue_cap_reached" });
      expect(t.createIssue).toHaveBeenCalledTimes(1);
      expect(file).toHaveBeenCalledTimes(3);
    });

    it("does not count failed creates", async () => {
      const t = creatingTracker();
      const { c } = creating(t, [capped(1), READ_LINK]);
      vi.mocked(t.createIssue).mockRejectedValueOnce(new IssueTrackerError("tracker_api_error", "boom"));
      expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "tracker_api_error" });
      expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ outcome: "created" });
      expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "issue_cap_reached" });
    });

    it("uses the recorded fingerprint creates of this run as a floor (a resumed attempt)", async () => {
      const t = creatingTracker();
      const { c, recordedCreates } = creating(t, [capped(2), READ_LINK], 2);
      expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "issue_cap_reached" });
      expect(recordedCreates).toHaveBeenCalledWith("PROJ");
      expect(t.createIssue).not.toHaveBeenCalled();
    });

    it("holds under concurrent calls", async () => {
      const t = creatingTracker();
      const { c } = creating(t, [capped(1), READ_LINK]);
      const results = await Promise.all([1, 2, 3].map(() => call("jira_create_issue", ARGS, c)));
      expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
      expect(results.filter((r) => r.error === "issue_cap_reached")).toHaveLength(2);
      expect(t.createIssue).toHaveBeenCalledTimes(1);
    });

    it("counts per project and null means unlimited", async () => {
      const t = creatingTracker();
      const ops: IssueProjectLink = { ...WRITE_LINK, projectKey: "OPS", maxNewIssuesPerRun: null };
      const { c } = creating(t, [capped(1), ops]);
      expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ outcome: "created" });
      for (let i = 0; i < 3; i++) {
        expect(await call("jira_create_issue", { ...ARGS, projectKey: "OPS" }, c)).toMatchObject({
          outcome: "created",
        });
      }
    });

    it("applies the live cap, not the pinned one", async () => {
      const t = creatingTracker();
      const { c } = creating(t, [capped(null), READ_LINK]);
      c.currentLink = async (k) => (k === "PROJ" ? capped(0) : null);
      expect(await call("jira_create_issue", ARGS, c)).toMatchObject({ error: "issue_cap_reached" });
    });
  });
});

describe("jira_read_attachment", () => {
  const def = ISSUE_TRACKER_TOOL_DEFS.find((t) => t.name === "jira_read_attachment")!;
  function withAttachment(t: IssueTracker, projectKey?: string) {
    vi.mocked(t.getIssue).mockImplementation(
      async (key: string) =>
        ({
          key,
          projectKey: projectKey ?? projectOf(key),
          attachments: [{ id: "500", filename: "log.txt", mimeType: "text/plain", size: 10 }],
        }) as never,
    );
    vi.mocked(t.readAttachmentText).mockResolvedValue({
      filename: "log.txt",
      mimeType: "text/plain",
      text: "ERROR at line 3",
      truncated: false,
    });
  }

  it("describes attachment text as untrusted", () => {
    expect(def.description).toMatch(/untrusted/i);
  });

  it("reads an attachment of an issue in a read-linked project, default 50000 bytes", async () => {
    const t = tracker();
    withAttachment(t);
    expect(await call("jira_read_attachment", { issueKey: "DOCS-1", attachmentId: "500" }, ctx(t))).toEqual({
      filename: "log.txt",
      mimeType: "text/plain",
      text: "ERROR at line 3",
      truncated: false,
    });
    expect(t.readAttachmentText).toHaveBeenCalledWith("500", 50_000);
  });

  it("passes maxBytes and rejects bad arguments", async () => {
    const t = tracker();
    withAttachment(t);
    await call("jira_read_attachment", { issueKey: "PROJ-1", attachmentId: "500", maxBytes: 1000 }, ctx(t));
    expect(t.readAttachmentText).toHaveBeenCalledWith("500", 1000);
    for (const bad of [
      { issueKey: "PROJ-1", attachmentId: "500", maxBytes: 200_001 },
      { issueKey: "PROJ-1", attachmentId: "500", maxBytes: 0 },
      { issueKey: "PROJ-1", attachmentId: "../500" },
      { issueKey: "PROJ-1" },
    ]) {
      expect(await call("jira_read_attachment", bad, ctx(t))).toMatchObject({ error: "invalid_arguments" });
    }
  });

  it("refuses an attachment that is not on the issue", async () => {
    const t = tracker();
    withAttachment(t);
    expect(await call("jira_read_attachment", { issueKey: "PROJ-1", attachmentId: "501" }, ctx(t))).toMatchObject({
      error: "tracker_not_found",
    });
    expect(t.readAttachmentText).not.toHaveBeenCalled();
  });

  it("refuses an unlinked project and an issue that resolves to one", async () => {
    const t = tracker();
    withAttachment(t);
    expect(await call("jira_read_attachment", { issueKey: "SECRET-1", attachmentId: "500" }, ctx(t))).toMatchObject({
      error: "project_not_linked",
    });
    withAttachment(t, "SECRET");
    expect(await call("jira_read_attachment", { issueKey: "PROJ-1", attachmentId: "500" }, ctx(t))).toMatchObject({
      error: "project_not_linked",
    });
    expect(t.readAttachmentText).not.toHaveBeenCalled();
  });
});
