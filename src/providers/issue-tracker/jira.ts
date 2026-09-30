/**
 * Jira Cloud implementation of IssueTracker over REST v3. Rich text is ADF
 * in and plain text out (adf.ts). The bot's comments carry a visible footer
 * naming the agent (ADF has no hidden comments), which is how
 * jira_edit_own_comment knows a comment is this agent's.
 */
import { adfToText, markdownToAdf } from "./adf.js";
import type { JiraClient } from "./jira-client.js";
import {
  IssueTrackerError,
  type IssueCommentView,
  type IssuePerson,
  type IssueSearchResult,
  type IssueTracker,
  type IssueTrackerIdentity,
  type IssueView,
} from "./types.js";

const ISSUE_FIELDS = "project,summary,description,status,issuetype,priority,labels,assignee,reporter,comment";
const MAX_DESCRIPTION = 20_000;
const MAX_COMMENT = 4_000;

export const agentFooter = (agentId: string): string => `_wardby agent ${agentId}_`;

/** Whether rendered comment text ends with this agent's footer (as adfToText renders it: no markdown underscores). */
export const hasAgentFooter = (text: string, agentId: string): boolean => {
  const last = text.trimEnd().split("\n").pop() ?? "";
  return last.trim() === `wardby agent ${agentId}`;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const person = (v: unknown): IssuePerson | null => {
  const p = obj(v);
  return typeof p.accountId === "string" ? { accountId: p.accountId, displayName: str(p.displayName) } : null;
};

export class JiraIssueTracker implements IssueTracker {
  readonly provider = "jira" as const;
  private me: Promise<IssueTrackerIdentity> | null = null;

  constructor(
    private readonly client: JiraClient,
    private readonly siteUrl: string,
  ) {}

  identity(): Promise<IssueTrackerIdentity> {
    const pending = (this.me ??= this.client.request<Json>("GET", "/rest/api/3/myself").then((me) => {
      if (typeof me.accountId !== "string") throw new IssueTrackerError("tracker_invalid_response");
      return { accountId: me.accountId, displayName: str(me.displayName), accountType: str(me.accountType) };
    }));
    pending.catch(() => {
      if (this.me === pending) this.me = null;
    });
    return pending;
  }

  async botAccountId(): Promise<string> {
    return (await this.identity()).accountId;
  }

  issueUrl(key: string): string {
    return `${this.siteUrl}/browse/${key}`;
  }

  async getIssue(key: string, opts: { maxComments: number; agentMarker: string }): Promise<IssueView> {
    const [raw, bot] = await Promise.all([
      this.client.request<Json>("GET", `/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`),
      this.botAccountId(),
    ]);
    const f = obj(raw.fields);
    const commentBlock = obj(f.comment);
    const all = Array.isArray(commentBlock.comments) ? commentBlock.comments.map(obj) : [];
    const recent = all.slice(-opts.maxComments);
    const comments: IssueCommentView[] = recent.map((c) => {
      const author = person(c.author);
      const full = adfToText(c.body, Infinity);
      const body = adfToText(c.body, MAX_COMMENT);
      return {
        id: str(c.id),
        author,
        created: str(c.created),
        body,
        byThisAgent: author?.accountId === bot && hasAgentFooter(full, opts.agentMarker),
      };
    });
    const total = typeof commentBlock.total === "number" ? commentBlock.total : all.length;
    return {
      key: str(raw.key),
      projectKey: str(obj(f.project).key),
      summary: str(f.summary),
      description: adfToText(f.description, MAX_DESCRIPTION),
      status: str(obj(f.status).name),
      issueType: str(obj(f.issuetype).name),
      priority: str(obj(f.priority).name) || null,
      labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [],
      assignee: person(f.assignee),
      reporter: person(f.reporter),
      url: this.issueUrl(str(raw.key)),
      comments,
      commentsTruncated: total > comments.length,
    };
  }

  async issueProject(key: string): Promise<string> {
    const raw = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}?fields=project`);
    const projectKey = obj(obj(raw.fields).project).key;
    if (typeof projectKey !== "string" || !projectKey) throw new IssueTrackerError("tracker_invalid_response");
    return projectKey;
  }

  async search(jql: string, opts: { maxResults: number }): Promise<IssueSearchResult> {
    const r = await this.client.request<Json>("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults: opts.maxResults,
      fields: ["summary", "status", "issuetype", "updated"],
    });
    const issues = (Array.isArray(r.issues) ? r.issues : []).map(obj).map((i) => {
      const f = obj(i.fields);
      return {
        key: str(i.key),
        summary: str(f.summary),
        status: str(obj(f.status).name),
        issueType: str(obj(f.issuetype).name),
        updated: str(f.updated),
        url: this.issueUrl(str(i.key)),
      };
    });
    return { issues, truncated: typeof r.nextPageToken === "string" };
  }

  async matchesJql(key: string, jql: string): Promise<boolean> {
    const r = await this.search(`issuekey = ${key} AND (${jql})`, { maxResults: 1 });
    return r.issues.length > 0;
  }

  async comment(
    key: string,
    input: { markdown: string; visibilityRole?: string },
  ): Promise<{ id: string; url: string }> {
    const r = await this.client.request<Json>("POST", `/rest/api/3/issue/${key}/comment`, {
      body: markdownToAdf(input.markdown),
      ...(input.visibilityRole ? { visibility: { type: "role", value: input.visibilityRole } } : {}),
    });
    if (typeof r.id !== "string") throw new IssueTrackerError("tracker_invalid_response");
    return { id: r.id, url: `${this.issueUrl(key)}?focusedCommentId=${r.id}` };
  }

  async editComment(key: string, commentId: string, input: { markdown: string }): Promise<void> {
    await this.client.request("PUT", `/rest/api/3/issue/${key}/comment/${commentId}`, {
      body: markdownToAdf(input.markdown),
    });
  }

  async readComment(key: string, commentId: string): Promise<{ authorId: string | null; body: string } | null> {
    try {
      const c = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}/comment/${commentId}`);
      return { authorId: person(c.author)?.accountId ?? null, body: adfToText(c.body, Infinity) };
    } catch (err) {
      if (err instanceof IssueTrackerError && err.code === "tracker_not_found") return null;
      throw err;
    }
  }
}
