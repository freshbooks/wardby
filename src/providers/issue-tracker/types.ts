/**
 * Host-neutral issue-tracker surface for native agents. Jira Cloud is the
 * first implementation (./jira.ts). The control plane holds the credential;
 * no method takes a token. See docs/private/2026-09-30-jira-issue-tracker-design.md.
 */
export type IssueTrackerProvider = "jira";
export const ISSUE_TRACKER_PROVIDERS: readonly IssueTrackerProvider[] = ["jira"];

export interface IssuePerson {
  accountId: string;
  displayName: string;
}

export interface IssueCommentView {
  id: string;
  author: IssuePerson | null;
  created: string;
  body: string;
  /** Written by the bot and carrying this agent's footer: editable with jira_edit_own_comment. */
  byThisAgent: boolean;
}

export interface IssueView {
  key: string;
  projectKey: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  priority: string | null;
  labels: string[];
  assignee: IssuePerson | null;
  reporter: IssuePerson | null;
  url: string;
  /** Most recent last; capped. */
  comments: IssueCommentView[];
  commentsTruncated: boolean;
}

export interface IssueSearchHit {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  updated: string;
  url: string;
}
export interface IssueSearchResult {
  issues: IssueSearchHit[];
  truncated: boolean;
}

/** Who the tracker credential acts as (Jira: GET /myself). */
export interface IssueTrackerIdentity {
  accountId: string;
  displayName: string;
  accountType: string;
}

export interface IssueTracker {
  readonly provider: IssueTrackerProvider;
  /** The bot's own accountId (cached after the first call). */
  botAccountId(): Promise<string>;
  /** The account the credential acts as, from the same cached call as botAccountId. */
  identity(): Promise<IssueTrackerIdentity>;
  getIssue(key: string, opts: { maxComments: number; agentMarker: string }): Promise<IssueView>;
  /** The project the issue is in now; an old key (kept as an alias after a move) resolves to its new project. */
  issueProject(key: string): Promise<string>;
  search(jql: string, opts: { maxResults: number }): Promise<IssueSearchResult>;
  /** Whether issue `key` matches `jql` (used for a link's jqlFilter). */
  matchesJql(key: string, jql: string): Promise<boolean>;
  comment(key: string, input: { markdown: string; visibilityRole?: string }): Promise<{ id: string; url: string }>;
  editComment(key: string, commentId: string, input: { markdown: string }): Promise<void>;
  /** The comment's author accountId and plain text (uncapped: only for ownership checks, never shown to a model), or null when it doesn't exist. */
  readComment(key: string, commentId: string): Promise<{ authorId: string | null; body: string } | null>;
  issueUrl(key: string): string;
  /** Transitions the service account can perform now: target status name + category. */
  transitions(key: string): Promise<Array<{ id: string; name: string; toStatus: string; toCategory: string }>>;
  /** Performs the transition whose target status name matches (case-insensitive). */
  transitionTo(key: string, toStatus: string): Promise<{ transitionId: string; toStatus: string }>;
  /** Field ids the service account may edit on this issue (from editmeta). */
  editableFields(key: string): Promise<string[]>;
  /** Sets fields: labels (string[]), components (names), priority (name), customfield_N (raw JSON value). */
  editFields(key: string, fields: Record<string, unknown>): Promise<void>;
  linkTypes(): Promise<Array<{ name: string; inward: string; outward: string }>>;
  linkIssues(input: { type: string; inwardKey: string; outwardKey: string }): Promise<void>;
  /** The property's JSON value, or null when it does not exist. */
  getProperty(key: string, property: string): Promise<unknown>;
  setProperty(key: string, property: string, value: unknown): Promise<void>;
}

export type IssueTrackerErrorCode =
  | "tracker_not_found"
  | "tracker_permission_denied"
  | "tracker_rate_limited"
  | "tracker_invalid_request"
  | "tracker_api_error"
  | "tracker_invalid_response";

export class IssueTrackerError extends Error {
  constructor(
    readonly code: IssueTrackerErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "IssueTrackerError";
  }
}

export type IssueTrackerRegistry = Partial<Record<IssueTrackerProvider, IssueTracker>>;

export type IssueEventKind = "created" | "transitioned" | "labeled" | "assigned" | "mention";

/** What a webhook adapter (jira-events.ts) normalises a payload into, for src/core/issue-events.ts. */
export interface IssueEvent {
  provider: IssueTrackerProvider;
  projectKey: string;
  issueKey: string;
  /** Every kind this one delivery represents (an update can transition AND label). */
  kinds: IssueEventKind[];
  actor: { accountId: string; displayName: string };
  /** The new status name, with "transitioned". */
  toStatus?: string;
  /** Labels added by this change, with "labeled". */
  addedLabels: string[];
  /** The new assignee's accountId, with "assigned". */
  assigneeAccountId?: string;
  /** The mentioning comment, with "mention". */
  comment?: { id: string; body: string };
  /** Untrusted: whoever wrote them was not gated. Absent when the payload lacked the issue. */
  subject?: { summary: string; description: string };
}

/** Shared by the ingress and the tools: a Jira issue key, e.g. PROJ-123. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,9}$/;
/** A Jira project key. */
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,254}$/;
export const projectOf = (issueKey: string): string => issueKey.slice(0, issueKey.lastIndexOf("-"));
