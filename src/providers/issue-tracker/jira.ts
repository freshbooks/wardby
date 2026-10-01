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
const PERSONAL_ACCOUNT_MESSAGE =
  "wardby's Jira token belongs to a person's account; use a service account (see docs/jira-agents.md).";

export const agentFooter = (agentId: string): string => `_wardby agent ${agentId}_`;

/** Whether rendered comment text ends with this agent's footer (as adfToText renders it: no markdown underscores). */
export const hasAgentFooter = (text: string, agentId: string): boolean => {
  const last = text.trimEnd().split("\n").pop() ?? "";
  return last.trim() === `wardby agent ${agentId}`;
};

/** Whether rendered comment text ends with wardby's run-status footer (`_wardby run <id>_` as adfToText renders it). */
export const isStatusComment = (text: string): boolean => {
  const last = text.trimEnd().split("\n").pop() ?? "";
  return /^wardby run \S+$/.test(last.trim());
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const person = (v: unknown): IssuePerson | null => {
  const p = obj(v);
  return typeof p.accountId === "string" ? { accountId: p.accountId, displayName: str(p.displayName) } : null;
};

/** Jira reports locales as "en_US"; Accept-Language wants BCP-47 ("en-US"). Anything malformed keeps the default. */
function localeToLanguageTag(locale: unknown): string {
  if (typeof locale !== "string") return "en-US";
  const m = /^([a-z]{2,3})(?:[_-]([A-Za-z]{2}|\d{3}))?$/.exec(locale.trim());
  return m ? (m[2] ? `${m[1]}-${m[2].toUpperCase()}` : m[1]) : "en-US";
}

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
      this.client.setLanguage(localeToLanguageTag(me.locale));
      return { accountId: me.accountId, displayName: str(me.displayName), accountType: str(me.accountType) };
    }));
    pending.catch(() => {
      if (this.me === pending) this.me = null;
    });
    return pending;
  }

  /** Refuses to act when the token belongs to a person; a failed identity() propagates and is not cached. */
  private async ready(): Promise<void> {
    if ((await this.identity()).accountType === "atlassian") {
      throw new IssueTrackerError("tracker_permission_denied", PERSONAL_ACCOUNT_MESSAGE);
    }
  }

  async botAccountId(): Promise<string> {
    return (await this.identity()).accountId;
  }

  issueUrl(key: string): string {
    return `${this.siteUrl}/browse/${key}`;
  }

  async getIssue(key: string, opts: { maxComments: number; agentMarker: string }): Promise<IssueView> {
    await this.ready();
    const [raw, bot] = await Promise.all([
      this.client.request<Json>("GET", `/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`),
      this.botAccountId(),
    ]);
    const f = obj(raw.fields);
    const commentBlock = obj(f.comment);
    const all = Array.isArray(commentBlock.comments) ? commentBlock.comments.map(obj) : [];
    // wardby's own status comments ("Working on it" / outcome) are not issue context and mislead agents; drop
    // them (bot-authored only) before windowing so they do not crowd out real comments.
    const visible = all.filter(
      (c) => !(person(c.author)?.accountId === bot && isStatusComment(adfToText(c.body, Infinity))),
    );
    const recent = visible.slice(-opts.maxComments);
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
      // True when non-status comments were omitted (the window cut some, or Jira returned only part of them).
      commentsTruncated: visible.length > comments.length || total > all.length,
    };
  }

  async issueProject(key: string): Promise<string> {
    await this.ready();
    const raw = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}?fields=project`);
    const projectKey = obj(obj(raw.fields).project).key;
    if (typeof projectKey !== "string" || !projectKey) throw new IssueTrackerError("tracker_invalid_response");
    return projectKey;
  }

  async search(
    jql: string,
    opts: { maxResults: number; timeoutMs?: number; retryOn429?: boolean },
  ): Promise<IssueSearchResult> {
    await this.ready();
    const r = await this.client.request<Json>(
      "POST",
      "/rest/api/3/search/jql",
      { jql, maxResults: opts.maxResults, fields: ["summary", "status", "issuetype", "updated"] },
      { timeoutMs: opts.timeoutMs, retryOn429: opts.retryOn429 },
    );
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

  async matchesJql(
    key: string,
    jql: string,
    opts: { timeoutMs?: number; retryOn429?: boolean } = {},
  ): Promise<boolean> {
    await this.ready();
    const r = await this.search(`issuekey = ${key} AND (${jql})`, { maxResults: 1, ...opts });
    return r.issues.length > 0;
  }

  async comment(
    key: string,
    input: { markdown: string; visibilityRole?: string },
  ): Promise<{ id: string; url: string }> {
    await this.ready();
    const r = await this.client.request<Json>("POST", `/rest/api/3/issue/${key}/comment`, {
      body: markdownToAdf(input.markdown),
      ...(input.visibilityRole ? { visibility: { type: "role", value: input.visibilityRole } } : {}),
    });
    if (typeof r.id !== "string") throw new IssueTrackerError("tracker_invalid_response");
    return { id: r.id, url: `${this.issueUrl(key)}?focusedCommentId=${r.id}` };
  }

  async editComment(key: string, commentId: string, input: { markdown: string }): Promise<void> {
    await this.ready();
    await this.client.request("PUT", `/rest/api/3/issue/${key}/comment/${commentId}`, {
      body: markdownToAdf(input.markdown),
    });
  }

  async readComment(key: string, commentId: string): Promise<{ authorId: string | null; body: string } | null> {
    await this.ready();
    try {
      const c = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}/comment/${commentId}`);
      return { authorId: person(c.author)?.accountId ?? null, body: adfToText(c.body, Infinity) };
    } catch (err) {
      if (err instanceof IssueTrackerError && err.code === "tracker_not_found") return null;
      throw err;
    }
  }

  async transitions(key: string): Promise<Array<{ id: string; name: string; toStatus: string; toCategory: string }>> {
    await this.ready();
    const r = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}/transitions`);
    return (Array.isArray(r.transitions) ? r.transitions : []).map(obj).map((t) => ({
      id: str(t.id),
      name: str(t.name),
      toStatus: str(obj(t.to).name),
      toCategory: str(obj(obj(t.to).statusCategory).key),
    }));
  }

  async transitionTo(key: string, toStatus: string): Promise<{ transitionId: string; toStatus: string }> {
    await this.ready();
    const wanted = toStatus.trim().toLowerCase();
    const match = (await this.transitions(key)).find((t) => t.toStatus.toLowerCase() === wanted);
    if (!match)
      throw new IssueTrackerError(
        "tracker_invalid_request",
        `No transition to "${toStatus}" is available from this issue's current status.`,
      );
    try {
      await this.client.request(
        "POST",
        `/rest/api/3/issue/${key}/transitions`,
        { transition: { id: match.id } },
        { allowEmpty: true },
      );
    } catch (err) {
      if (err instanceof IssueTrackerError && err.code === "tracker_invalid_request")
        throw new IssueTrackerError(
          "tracker_invalid_request",
          "This transition needs fields wardby can't fill (a transition screen); do it in Jira.",
        );
      throw err;
    }
    return { transitionId: match.id, toStatus: match.toStatus };
  }

  async editableFields(key: string): Promise<string[]> {
    await this.ready();
    const r = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}/editmeta`);
    return Object.keys(obj(r.fields));
  }

  async editFields(key: string, fields: Record<string, unknown>): Promise<void> {
    await this.ready();
    const body: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(fields)) {
      if (id === "components" && Array.isArray(value)) body[id] = value.map((name: unknown) => ({ name }));
      else if (id === "priority" && typeof value === "string") body[id] = { name: value };
      else body[id] = value;
    }
    await this.client.request("PUT", `/rest/api/3/issue/${key}`, { fields: body }, { allowEmpty: true });
  }

  async linkTypes(): Promise<Array<{ name: string; inward: string; outward: string }>> {
    await this.ready();
    const r = await this.client.request<Json>("GET", "/rest/api/3/issueLinkType");
    return (Array.isArray(r.issueLinkTypes) ? r.issueLinkTypes : []).map(obj).map((t) => ({
      name: str(t.name),
      inward: str(t.inward),
      outward: str(t.outward),
    }));
  }

  async linkIssues(input: { type: string; inwardKey: string; outwardKey: string }): Promise<void> {
    await this.ready();
    await this.client.request(
      "POST",
      "/rest/api/3/issueLink",
      {
        type: { name: input.type },
        inwardIssue: { key: input.inwardKey },
        outwardIssue: { key: input.outwardKey },
      },
      { allowEmpty: true },
    );
  }

  async getProperty(key: string, property: string): Promise<unknown> {
    await this.ready();
    try {
      const r = await this.client.request<Json>(
        "GET",
        `/rest/api/3/issue/${key}/properties/${encodeURIComponent(property)}`,
      );
      return r.value ?? null;
    } catch (err) {
      if (err instanceof IssueTrackerError && err.code === "tracker_not_found") return null;
      throw err;
    }
  }

  async setProperty(key: string, property: string, value: unknown): Promise<void> {
    await this.ready();
    await this.client.request("PUT", `/rest/api/3/issue/${key}/properties/${encodeURIComponent(property)}`, value, {
      allowEmpty: true,
    });
  }
}
