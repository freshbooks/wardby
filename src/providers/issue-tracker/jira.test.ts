import { describe, expect, it, vi } from "vitest";
import { JiraClient } from "./jira-client.js";
import { JiraIssueTracker } from "./jira.js";
import { IssueTrackerError } from "./types.js";

const SITE = "https://your-site.atlassian.net";
type Call = { method: string; path: string; body: unknown; authorization: string | null };

function fake(handler: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    return handler(call) ?? new Response("{}", { status: 404 });
  });
  const client = new JiraClient(
    { apiBaseUrl: SITE, auth: { kind: "bearer", token: "tok" } },
    { fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined },
  );
  return { tracker: new JiraIssueTracker(client, SITE), calls };
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

const doc = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("JiraIssueTracker", () => {
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

  it("matchesJql wraps the filter so it cannot widen the query", async () => {
    const { tracker, calls } = fake(() => json({ issues: [] }));
    expect(await tracker.matchesJql("PROJ-1", "labels = x OR 1=1")).toBe(false);
    expect((calls[0].body as { jql: string }).jql).toBe("issuekey = PROJ-1 AND (labels = x OR 1=1)");
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
});
