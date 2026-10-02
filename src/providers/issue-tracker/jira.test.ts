import { describe, expect, it, vi } from "vitest";
import { toJiraMarkdown } from "../../core/issue-status.js";
import { markdownToAdf } from "./adf.js";
import { JiraClient } from "./jira-client.js";
import { isStatusComment, JiraIssueTracker } from "./jira.js";
import { IssueTrackerError } from "./types.js";

const SITE = "https://your-site.atlassian.net";
type Call = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
  acceptLanguage: string | null;
};

function fake(handler: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  const languages: (string | null)[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
      acceptLanguage: new Headers(init?.headers).get("accept-language"),
    };
    languages.push(call.acceptLanguage);
    const handled = handler(call);
    // Unless a test handles /myself itself, the token is a service account ("app") and the guard's lookup is not a recorded call.
    if (!handled && call.path === "/rest/api/3/myself") return json({ accountId: "bot-1", accountType: "app" });
    calls.push(call);
    return handled ?? new Response("{}", { status: 404 });
  });
  const client = new JiraClient(
    { apiBaseUrl: SITE, auth: { kind: "bearer", token: "tok" } },
    { fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined },
  );
  return { tracker: new JiraIssueTracker(client, SITE), calls, languages };
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

const doc = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("JiraIssueTracker", () => {
  it("refuses every method when the token belongs to a person, with no other HTTP call", async () => {
    const { tracker, calls } = fake((c) =>
      c.path === "/rest/api/3/myself" ? json({ accountId: "u-1", accountType: "atlassian" }) : undefined,
    );
    const denied = { code: "tracker_permission_denied", message: expect.stringContaining("service account") };
    await expect(tracker.getIssue("KAN-1", { maxComments: 5, agentMarker: "a" })).rejects.toMatchObject(denied);
    await expect(tracker.comment("KAN-1", { markdown: "hi" })).rejects.toMatchObject(denied);
    await expect(tracker.search("project = KAN", { maxResults: 5 })).rejects.toMatchObject(denied);
    await expect(tracker.transitions("KAN-1")).rejects.toMatchObject(denied);
    await expect(tracker.setProperty("KAN-1", "p", {})).rejects.toBeInstanceOf(IssueTrackerError);
    expect(calls.map((c) => c.path)).toEqual(["/rest/api/3/myself"]);
    expect((await tracker.identity()).accountType).toBe("atlassian");
  });

  it("sends Accept-Language on every request: en-US until identity, then the account's locale", async () => {
    const { tracker, languages } = fake((c) =>
      c.path === "/rest/api/3/myself"
        ? json({ accountId: "bot-1", accountType: "app", locale: "zh_CN" })
        : json({ issues: [] }),
    );
    await tracker.identity();
    await tracker.search("project = X", { maxResults: 5 });
    expect(languages[0]).toBe("en-US");
    expect(languages.length).toBeGreaterThan(1);
    expect(languages.slice(1).every((l) => l === "zh-CN")).toBe(true);
  });

  it.each([
    ["en_US", "en-US"],
    ["pt_BR", "pt-BR"],
    ["bad locale!", "en-US"],
    [42, "en-US"],
    [undefined, "en-US"],
  ])("maps locale %j to %s", async (locale, expected) => {
    const { tracker, languages } = fake((c) =>
      c.path === "/rest/api/3/myself" ? json({ accountId: "bot-1", accountType: "app", locale }) : json({ issues: [] }),
    );
    await tracker.identity();
    await tracker.search("project = X", { maxResults: 5 });
    expect(languages.at(-1)).toBe(expected);
  });

  it("does not cache a failed identity lookup as a refusal", async () => {
    let n = 0;
    const { tracker } = fake((c) => {
      if (c.path !== "/rest/api/3/myself") return json({ issues: [] });
      return ++n === 1 ? new Response("{}", { status: 400 }) : json({ accountId: "b", accountType: "app" });
    });
    await expect(tracker.search("x", { maxResults: 1 })).rejects.toBeInstanceOf(IssueTrackerError);
    await expect(tracker.search("x", { maxResults: 1 })).resolves.toMatchObject({ issues: [] });
  });

  it("sends Bearer auth and caches the bot account id", async () => {
    const { tracker, calls } = fake((c) =>
      c.path === "/rest/api/3/myself" ? json({ accountId: "bot-1" }) : undefined,
    );
    expect(await tracker.botAccountId()).toBe("bot-1");
    expect(await tracker.botAccountId()).toBe("bot-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe("Bearer tok");
  });

  it("identity() and botAccountId() share one cached /myself call", async () => {
    const { tracker, calls } = fake((c) =>
      c.path === "/rest/api/3/myself"
        ? json({ accountId: "bot-1", displayName: "wardby bot", accountType: "app" })
        : undefined,
    );
    expect(await tracker.identity()).toEqual({ accountId: "bot-1", displayName: "wardby bot", accountType: "app" });
    expect(await tracker.botAccountId()).toBe("bot-1");
    expect(await tracker.identity()).toEqual({ accountId: "bot-1", displayName: "wardby bot", accountType: "app" });
    expect(calls).toHaveLength(1);
  });

  it("identity() retries after a failed /myself", async () => {
    let n = 0;
    const { tracker, calls } = fake((c) =>
      c.path === "/rest/api/3/myself" && ++n > 1 ? json({ accountId: "bot-1" }) : json({}, 500),
    );
    await expect(tracker.identity()).rejects.toBeInstanceOf(IssueTrackerError);
    expect((await tracker.identity()).accountId).toBe("bot-1");
    expect(calls).toHaveLength(2);
  });

  it("reads an issue as plain text and flags this agent's own comments", async () => {
    const { tracker } = fake((c) => {
      if (c.path === "/rest/api/3/myself") return json({ accountId: "bot-1" });
      if (c.path.startsWith("/rest/api/3/issue/PROJ-1?")) {
        return json({
          key: "PROJ-1",
          fields: {
            project: { key: "PROJ" },
            summary: "Login fails",
            description: doc("Steps"),
            status: { name: "To Do" },
            issuetype: { name: "Bug" },
            priority: { name: "High" },
            labels: ["auth"],
            assignee: null,
            reporter: { accountId: "u-1", displayName: "Ada" },
            comment: {
              total: 3,
              comments: [
                { id: "10", author: { accountId: "u-1", displayName: "Ada" }, created: "t1", body: doc("hi") },
                {
                  id: "11",
                  author: { accountId: "bot-1", displayName: "wardby" },
                  created: "t2",
                  body: doc(`done\nwardby agent agent-7`),
                },
              ],
            },
          },
        });
      }
      return undefined;
    });
    const issue = await tracker.getIssue("PROJ-1", { maxComments: 2, agentMarker: "agent-7" });
    expect(issue).toMatchObject({
      key: "PROJ-1",
      projectKey: "PROJ",
      description: "Steps",
      status: "To Do",
      priority: "High",
      url: `${SITE}/browse/PROJ-1`,
      commentsTruncated: true,
    });
    expect(issue.comments.map((c) => [c.id, c.byThisAgent])).toEqual([
      ["10", false],
      ["11", true],
    ]);
  });

  it("posts comments as ADF with the agent-independent body and optional role visibility", async () => {
    const { tracker, calls } = fake((c) =>
      c.method === "POST" && c.path === "/rest/api/3/issue/PROJ-1/comment" ? json({ id: "55" }) : undefined,
    );
    expect(await tracker.comment("PROJ-1", { markdown: "**ok**", visibilityRole: "Developers" })).toEqual({
      id: "55",
      url: `${SITE}/browse/PROJ-1?focusedCommentId=55`,
    });
    expect(calls[0].body).toMatchObject({
      body: { type: "doc", version: 1 },
      visibility: { type: "role", value: "Developers" },
    });
  });

  it("searches with the enhanced JQL endpoint and reports truncation", async () => {
    const { tracker, calls } = fake((c) =>
      c.method === "POST" && c.path === "/rest/api/3/search/jql"
        ? json({
            issues: [
              {
                key: "PROJ-2",
                fields: { summary: "S", status: { name: "Done" }, issuetype: { name: "Task" }, updated: "u" },
              },
            ],
            nextPageToken: "more",
          })
        : undefined,
    );
    const r = await tracker.search("project = PROJ", { maxResults: 1 });
    expect(r).toEqual({
      issues: [
        { key: "PROJ-2", summary: "S", status: "Done", issueType: "Task", updated: "u", url: `${SITE}/browse/PROJ-2` },
      ],
      truncated: true,
    });
    expect(calls[0].body).toMatchObject({ jql: "project = PROJ", maxResults: 1 });
  });

  it("issueProject reads only the project field and returns its current key", async () => {
    const { tracker, calls } = fake((c) =>
      c.path === "/rest/api/3/issue/PROJ-7?fields=project"
        ? json({ key: "SECRET-3", fields: { project: { key: "SECRET" } } })
        : undefined,
    );
    expect(await tracker.issueProject("PROJ-7")).toBe("SECRET");
    expect(calls).toHaveLength(1);
  });

  it("issueProject rejects a response without a project key", async () => {
    const { tracker } = fake(() => json({ fields: {} }));
    await expect(tracker.issueProject("PROJ-7")).rejects.toMatchObject({ code: "tracker_invalid_response" });
  });

  it("matchesJql wraps the filter so it cannot widen the query", async () => {
    const { tracker, calls } = fake((c) => (c.path === "/rest/api/3/myself" ? undefined : json({ issues: [] })));
    expect(await tracker.matchesJql("PROJ-1", "labels = x OR 1=1")).toBe(false);
    expect((calls[0].body as { jql: string }).jql).toBe("issuekey = PROJ-1 AND (labels = x OR 1=1)");
  });

  it("matchesJql forwards a short timeout that aborts a hanging request, so the caller fails closed", async () => {
    const hang = vi.fn((_url: string, init?: RequestInit) => {
      if (String(_url).endsWith("/myself")) return Promise.resolve(json({ accountId: "bot-1", accountType: "app" }));
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("x"))));
    });
    const client = new JiraClient(
      { apiBaseUrl: SITE, auth: { kind: "bearer", token: "tok" } },
      { fetch: hang as unknown as typeof fetch },
    );
    const tracker = new JiraIssueTracker(client, SITE);
    await expect(tracker.matchesJql("PROJ-1", "a = b", { timeoutMs: 20 })).rejects.toMatchObject({
      code: "tracker_api_error",
    });
  });

  it("matchesJql with retryOn429 false surfaces the first 429 without retrying", async () => {
    let searches = 0;
    const { tracker } = fake((c) => {
      if (c.path === "/rest/api/3/myself") return undefined;
      searches++;
      return json({}, 429, { "retry-after": "1" });
    });
    await expect(tracker.matchesJql("PROJ-1", "a = b", { retryOn429: false })).rejects.toMatchObject({
      code: "tracker_rate_limited",
    });
    expect(searches).toBe(1);
  });

  it("retries a 429 once after Retry-After, then maps errors", async () => {
    let n = 0;
    const { tracker } = fake((c) => {
      if (c.path !== "/rest/api/3/myself") return undefined;
      n++;
      return n === 1 ? json({}, 429, { "retry-after": "1" }) : json({ accountId: "bot-1" });
    });
    expect(await tracker.botAccountId()).toBe("bot-1");
    const { tracker: t2 } = fake(() => json({ errorMessages: ["nope"] }, 403));
    await expect(t2.getIssue("PROJ-1", { maxComments: 5, agentMarker: "a" })).rejects.toMatchObject({
      code: "tracker_permission_denied",
    });
    const { tracker: t3 } = fake(() => undefined);
    await expect(t3.getIssue("PROJ-1", { maxComments: 5, agentMarker: "a" })).rejects.toBeInstanceOf(IssueTrackerError);
  });

  it("checks ownership against the full text of long comments and matches the footer exactly", async () => {
    const long = `${"x".repeat(5000)}\nwardby agent agent-7`;
    const { tracker } = fake((c) => {
      if (c.path === "/rest/api/3/myself") return json({ accountId: "bot-1" });
      if (c.path.startsWith("/rest/api/3/issue/PROJ-1/comment/")) {
        return c.path.endsWith("/9")
          ? json({ id: "9", author: { accountId: "bot-1" }, body: doc(long) })
          : json({}, 404);
      }
      if (c.path.startsWith("/rest/api/3/issue/PROJ-1?")) {
        const bot = { accountId: "bot-1", displayName: "wardby" };
        return json({
          key: "PROJ-1",
          fields: {
            comment: {
              total: 2,
              comments: [
                { id: "1", author: bot, created: "t", body: doc(long) },
                { id: "2", author: bot, created: "t", body: doc("hi\nwardby agent agent-70") },
              ],
            },
          },
        });
      }
      return undefined;
    });
    const issue = await tracker.getIssue("PROJ-1", { maxComments: 5, agentMarker: "agent-7" });
    expect(issue.comments.map((c) => c.byThisAgent)).toEqual([true, false]);
    expect(issue.comments[0].body.length).toBeLessThan(4100);
    const read = await tracker.readComment("PROJ-1", "9");
    expect(read?.authorId).toBe("bot-1");
    expect(read?.body).toBe(long);
    expect(await tracker.readComment("PROJ-1", "404")).toBeNull();
  });
  it("hides wardby status comments, keeps agent replies and human look-alikes", async () => {
    const bot = { accountId: "bot-1", displayName: "wardby" };
    const human = { accountId: "u-1", displayName: "Ann" };
    const status = markdownToAdf(toJiraMarkdown("👀 Working on it\n\n<sub>wardby run `run-9`</sub>"));
    const { tracker } = fake((c) => {
      if (c.path === "/rest/api/3/myself") return json({ accountId: "bot-1" });
      if (c.path.startsWith("/rest/api/3/issue/PROJ-1?")) {
        return json({
          key: "PROJ-1",
          fields: {
            comment: {
              total: 4,
              comments: [
                { id: "1", author: human, created: "t", body: doc("see\nwardby run x") },
                { id: "2", author: bot, created: "t", body: status },
                { id: "3", author: bot, created: "t", body: doc("reply\nwardby agent agent-7") },
                { id: "4", author: bot, created: "t", body: status },
              ],
            },
          },
        });
      }
      return undefined;
    });
    const two = await tracker.getIssue("PROJ-1", { maxComments: 2, agentMarker: "agent-7" });
    expect(two.comments.map((c) => c.id)).toEqual(["1", "3"]);
    expect(two.commentsTruncated).toBe(false);
    const one = await tracker.getIssue("PROJ-1", { maxComments: 1, agentMarker: "agent-7" });
    expect(one.comments.map((c) => c.id)).toEqual(["3"]);
    expect(one.commentsTruncated).toBe(true);
  });

  it("isStatusComment matches the rendered run footer on the last line only", () => {
    expect(isStatusComment("done\nwardby run abc")).toBe(true);
    expect(isStatusComment("wardby run abc\nmore")).toBe(false);
    expect(isStatusComment("wardby agent abc")).toBe(false);
  });

  describe("phase 2 methods", () => {
    const transitionsBody = {
      transitions: [
        { id: "11", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
        { id: "31", name: "Finish", to: { name: "Done", statusCategory: { key: "done" } } },
      ],
    };

    it("lists transitions with target status and category", async () => {
      const { tracker } = fake((c) =>
        c.path === "/rest/api/3/issue/PROJ-1/transitions" ? json(transitionsBody) : undefined,
      );
      expect(await tracker.transitions("PROJ-1")).toEqual([
        { id: "11", name: "Start", toStatus: "In Progress", toCategory: "indeterminate" },
        { id: "31", name: "Finish", toStatus: "Done", toCategory: "done" },
      ]);
    });

    it("transitions by target status name, case-insensitively, posting the transition id", async () => {
      const { tracker, calls } = fake((c) => {
        if (c.path === "/rest/api/3/issue/PROJ-1/transitions") {
          return c.method === "GET" ? json(transitionsBody) : new Response(null, { status: 204 });
        }
        return undefined;
      });
      expect(await tracker.transitionTo("PROJ-1", "in progress")).toEqual({
        transitionId: "11",
        toStatus: "In Progress",
      });
      const post = calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual({ transition: { id: "11" } });
    });

    it("rejects a transition with no matching target status", async () => {
      const { tracker, calls } = fake((c) =>
        c.path === "/rest/api/3/issue/PROJ-1/transitions" ? json(transitionsBody) : undefined,
      );
      await expect(tracker.transitionTo("PROJ-1", "Blocked")).rejects.toMatchObject({
        code: "tracker_invalid_request",
        message: 'No transition to "Blocked" is available from this issue\'s current status.',
      });
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    it("explains a 400 on the transition as a transition screen", async () => {
      const { tracker } = fake((c) => {
        if (c.path === "/rest/api/3/issue/PROJ-1/transitions") {
          return c.method === "GET" ? json(transitionsBody) : json({ errors: {} }, 400);
        }
        return undefined;
      });
      await expect(tracker.transitionTo("PROJ-1", "Done")).rejects.toMatchObject({
        code: "tracker_invalid_request",
        message: "This transition needs fields wardby can't fill (a transition screen); do it in Jira.",
      });
    });

    it("lists editable field ids from editmeta", async () => {
      const { tracker } = fake((c) =>
        c.path === "/rest/api/3/issue/PROJ-1/editmeta"
          ? json({ fields: { labels: {}, priority: {}, customfield_10010: {} } })
          : undefined,
      );
      expect(await tracker.editableFields("PROJ-1")).toEqual(["labels", "priority", "customfield_10010"]);
    });

    it("shapes the editFields body", async () => {
      const { tracker, calls } = fake((c) =>
        c.method === "PUT" && c.path === "/rest/api/3/issue/PROJ-1" ? new Response(null, { status: 204 }) : undefined,
      );
      await tracker.editFields("PROJ-1", {
        labels: ["a", "b"],
        components: ["Api", "Web"],
        priority: "High",
        customfield_10010: { value: "x" },
      });
      expect(calls[0].body).toEqual({
        fields: {
          labels: ["a", "b"],
          components: [{ name: "Api" }, { name: "Web" }],
          priority: { name: "High" },
          customfield_10010: { value: "x" },
        },
      });
    });

    it("lists link types", async () => {
      const { tracker } = fake((c) =>
        c.path === "/rest/api/3/issueLinkType"
          ? json({ issueLinkTypes: [{ id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" }] })
          : undefined,
      );
      expect(await tracker.linkTypes()).toEqual([{ name: "Blocks", inward: "is blocked by", outward: "blocks" }]);
    });

    it("posts the link body", async () => {
      const { tracker, calls } = fake((c) =>
        c.method === "POST" && c.path === "/rest/api/3/issueLink" ? new Response(null, { status: 201 }) : undefined,
      );
      await tracker.linkIssues({ type: "Blocks", inwardKey: "PROJ-2", outwardKey: "PROJ-1" });
      expect(calls[0].body).toEqual({
        type: { name: "Blocks" },
        inwardIssue: { key: "PROJ-2" },
        outwardIssue: { key: "PROJ-1" },
      });
    });

    it("posts a remote link with its globalId", async () => {
      const { tracker, calls } = fake((c) =>
        c.method === "POST" && c.path === "/rest/api/3/issue/PROJ-1/remotelink"
          ? json({ id: 10, self: "https://x/remotelink/10" }, 201)
          : undefined,
      );
      await tracker.addRemoteLink("PROJ-1", {
        globalId: "wardby:pr:github:o/r#4",
        url: "https://github.com/o/r/pull/4",
        title: "o/r#4",
      });
      expect(calls[0].body).toEqual({
        globalId: "wardby:pr:github:o/r#4",
        object: { url: "https://github.com/o/r/pull/4", title: "o/r#4" },
      });
    });

    it("reads a property's value, null on 404", async () => {
      const { tracker, calls } = fake((c) => {
        if (c.path === "/rest/api/3/issue/PROJ-1/properties/wardby.state")
          return json({ key: "wardby.state", value: { n: 1 } });
        return undefined;
      });
      expect(await tracker.getProperty("PROJ-1", "wardby.state")).toEqual({ n: 1 });
      expect(await tracker.getProperty("PROJ-1", "missing key")).toBeNull();
      expect(calls[1].path).toBe("/rest/api/3/issue/PROJ-1/properties/missing%20key");
    });

    it("sets a property with the raw JSON value", async () => {
      const { tracker, calls } = fake((c) =>
        c.path === "/rest/api/3/myself" ? undefined : new Response(null, { status: 200 }),
      );
      await tracker.setProperty("PROJ-1", "wardby.state", { n: 2 });
      expect(calls[0]).toMatchObject({
        method: "PUT",
        path: "/rest/api/3/issue/PROJ-1/properties/wardby.state",
        body: { n: 2 },
      });
    });

    it("rejects an empty 200 on a JSON-returning call as tracker_invalid_response", async () => {
      const { tracker } = fake(() => new Response("", { status: 200 }));
      await expect(tracker.issueProject("PROJ-1")).rejects.toMatchObject({ code: "tracker_invalid_response" });
      await expect(tracker.search("project = PROJ", { maxResults: 1 })).rejects.toMatchObject({
        code: "tracker_invalid_response",
      });
    });

    it("accepts an empty 201 on linkIssues", async () => {
      const { tracker } = fake((c) =>
        c.path === "/rest/api/3/myself"
          ? json({ accountId: "bot-1", accountType: "app" })
          : new Response("", { status: 201 }),
      );
      await expect(
        tracker.linkIssues({ type: "Blocks", inwardKey: "PROJ-2", outwardKey: "PROJ-1" }),
      ).resolves.toBeUndefined();
    });
  });
});

describe("JiraIssueTracker issue creation and attachments", () => {
  const types = {
    startAt: 0,
    total: 2,
    issueTypes: [
      { id: "10001", name: "Bug", subtask: false },
      { id: "10002", name: "Sub-task", subtask: true },
    ],
  };
  const fieldsPage = (fields: unknown[]) => ({ startAt: 0, total: fields.length, fields });
  const bugFields = [
    { fieldId: "summary", name: "Summary", required: true, hasDefaultValue: false },
    { fieldId: "issuetype", name: "Issue Type", required: true, hasDefaultValue: false },
    { fieldId: "customfield_10050", name: "Environment", required: true, hasDefaultValue: false },
    { fieldId: "priority", name: "Priority", required: true, hasDefaultValue: true, allowedValues: [{ name: "High" }] },
    { fieldId: "labels", name: "Labels", required: false, hasDefaultValue: false },
  ];
  const meta = (c: { path: string }) =>
    c.path.startsWith("/rest/api/3/issue/createmeta/KAN/issuetypes/10001")
      ? json(fieldsPage(bugFields))
      : c.path.startsWith("/rest/api/3/issue/createmeta/KAN/issuetypes")
        ? json(types)
        : undefined;

  it("createMeta and fieldMeta map the paged responses", async () => {
    const { tracker } = fake(meta);
    expect(await tracker.createMeta("KAN")).toEqual({
      issueTypes: [
        { id: "10001", name: "Bug", subtask: false },
        { id: "10002", name: "Sub-task", subtask: true },
      ],
    });
    const fields = await tracker.fieldMeta("KAN", "10001");
    expect(fields.find((f) => f.fieldId === "priority")).toEqual({
      fieldId: "priority",
      name: "Priority",
      required: true,
      hasDefault: true,
      allowedValues: ["High"],
    });
    expect(fields.find((f) => f.fieldId === "labels")).not.toHaveProperty("allowedValues");
  });

  it("pages createmeta until total is reached", async () => {
    const { tracker, calls } = fake((c) => {
      if (c.path === "/rest/api/3/myself") return undefined;
      const start = Number(new URL(`${SITE}${c.path}`).searchParams.get("startAt"));
      const issueTypes = Array.from({ length: start === 0 ? 50 : 3 }, (_, i) => ({
        id: String(start + i),
        name: `T${start + i}`,
      }));
      return json({ startAt: start, total: 53, issueTypes });
    });
    expect((await tracker.createMeta("KAN")).issueTypes).toHaveLength(53);
    expect(calls.map((c) => c.path)).toEqual([
      "/rest/api/3/issue/createmeta/KAN/issuetypes?startAt=0&maxResults=50",
      "/rest/api/3/issue/createmeta/KAN/issuetypes?startAt=50&maxResults=50",
    ]);
  });

  it("createIssue resolves the type case-insensitively and posts fields plus properties", async () => {
    const { tracker, calls } = fake((c) => (c.method === "POST" ? json({ id: "1", key: "KAN-9" }, 201) : meta(c)));
    const r = await tracker.createIssue({
      projectKey: "KAN",
      issueType: "bug",
      summary: "Crash",
      descriptionMarkdown: "details",
      labels: ["a"],
      priority: "High",
      components: ["api"],
      parentKey: "KAN-1",
      customFields: { customfield_10050: "prod" },
      properties: { "wardby.fp": { h: "x" } },
    });
    expect(r).toEqual({ key: "KAN-9", url: `${SITE}/browse/KAN-9` });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/rest/api/3/issue");
    expect(post.body).toEqual({
      fields: {
        project: { key: "KAN" },
        issuetype: { id: "10001" },
        summary: "Crash",
        description: markdownToAdf("details"),
        labels: ["a"],
        priority: { name: "High" },
        components: [{ name: "api" }],
        parent: { key: "KAN-1" },
        customfield_10050: "prod",
      },
      properties: [{ key: "wardby.fp", value: { h: "x" } }],
    });
  });

  it("createIssue lists missing required fields (no default) and does not POST", async () => {
    const { tracker, calls } = fake(meta);
    await expect(
      tracker.createIssue({ projectKey: "KAN", issueType: "Bug", summary: "s", descriptionMarkdown: "d" }),
    ).rejects.toMatchObject({ code: "tracker_invalid_request", message: expect.stringContaining("Environment") });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("createIssue rejects an unknown issue type", async () => {
    const { tracker } = fake(meta);
    await expect(
      tracker.createIssue({ projectKey: "KAN", issueType: "Epic", summary: "s", descriptionMarkdown: "d" }),
    ).rejects.toMatchObject({ code: "tracker_invalid_request" });
  });

  it("getIssue exposes statusCategory and a capped attachment list", async () => {
    const attachment = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      filename: `f${i}.log`,
      mimeType: "text/plain",
      size: 10,
    }));
    const { tracker } = fake((c) =>
      c.path === "/rest/api/3/myself"
        ? undefined
        : json({
            key: "KAN-1",
            fields: { status: { name: "Done", statusCategory: { key: "done" } }, attachment },
          }),
    );
    const v = await tracker.getIssue("KAN-1", { maxComments: 5, agentMarker: "a" });
    expect(v.statusCategory).toBe("done");
    expect(v.attachments).toHaveLength(20);
    expect(v.attachments[0]).toEqual({ id: "0", filename: "f0.log", mimeType: "text/plain", size: 10 });
  });

  const attachmentFake = (mimeType: string, size: number, content: (c: Call) => Response) =>
    fake((c) =>
      c.path === "/rest/api/3/attachment/7"
        ? json({ id: "7", filename: "app.log", mimeType, size })
        : c.path.startsWith("/rest/api/3/attachment/content/7")
          ? content(c)
          : undefined,
    );

  it("readAttachmentText requests a Range with redirect=false and flags truncation", async () => {
    let auth: string | null = null;
    const { tracker, calls } = attachmentFake("text/plain", 100, (c) => {
      auth = c.authorization;
      return new Response("hello wörld", { status: 206 });
    });
    const r = await tracker.readAttachmentText("7", 12);
    expect(r).toEqual({ filename: "app.log", mimeType: "text/plain", text: "hello wörld", truncated: true });
    expect(calls.at(-1)!.path).toBe("/rest/api/3/attachment/content/7?redirect=false");
    expect(auth).toBe("Bearer tok");
  });

  it("readAttachmentText caps client-side when the server ignores Range", async () => {
    const { tracker } = attachmentFake("application/json", 20, () => new Response("0123456789ABCDEFGHIJ"));
    const r = await tracker.readAttachmentText("7", 10);
    expect(r.text).toBe("0123456789");
    expect(r.truncated).toBe(true);
    const whole = await attachmentFake(
      "application/vnd.api+json",
      5,
      () => new Response("hello"),
    ).tracker.readAttachmentText("7", 10);
    expect(whole).toMatchObject({ text: "hello", truncated: false });
  });

  it("readAttachmentText sends the Range header", async () => {
    const ranges: (string | null)[] = [];
    const client = new JiraClient(
      { apiBaseUrl: SITE, auth: { kind: "bearer", token: "tok" } },
      {
        fetch: (async (url: string, init?: RequestInit) => {
          ranges.push(new Headers(init?.headers).get("range"));
          return new Response("abc", { status: 206 });
        }) as unknown as typeof fetch,
      },
    );
    await client.requestBytes("/x", { maxBytes: 3 });
    expect(ranges).toEqual(["bytes=0-2"]);
  });

  it("readAttachmentText refuses non-text types without fetching content", async () => {
    const { tracker, calls } = attachmentFake("image/png", 10, () => new Response("x"));
    await expect(tracker.readAttachmentText("7", 10)).rejects.toMatchObject({ code: "tracker_invalid_request" });
    expect(calls.some((c) => c.path.includes("content"))).toBe(false);
  });

  it("follows a 303 only to an Atlassian host and without the Jira credential", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const mk = (location: string) =>
      new JiraClient(
        { apiBaseUrl: SITE, auth: { kind: "bearer", token: "tok" } },
        {
          fetch: (async (url: string, init?: RequestInit) => {
            seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
            return url.startsWith(SITE)
              ? new Response(null, { status: 303, headers: { location } })
              : new Response("media", { status: 200 });
          }) as unknown as typeof fetch,
        },
      );
    const ok = await mk("https://api.media.atlassian.com/file/1").requestBytes("/x", { maxBytes: 10 });
    expect(Buffer.from(ok).toString()).toBe("media");
    expect(seen[1]).toEqual({ url: "https://api.media.atlassian.com/file/1", auth: null });
    seen.length = 0;
    await expect(mk("https://evil.example.com/x").requestBytes("/x", { maxBytes: 10 })).rejects.toMatchObject({
      code: "tracker_invalid_response",
    });
    expect(seen).toHaveLength(1);
  });
});
