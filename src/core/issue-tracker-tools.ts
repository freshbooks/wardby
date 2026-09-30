/**
 * Built-in issue-tracker tools (`jira_*`) for native agents with at least one
 * AgentIssueProject link. Like the repo_* built-ins (review-host-tools.ts)
 * they are synthesized by the runner, recognized by name, and never run in
 * the sandbox. The security boundary is here: every call resolves to a Jira
 * project, which must be one of this agent's links and still be linked right
 * now (with write access for write tools); searches are scoped to the linked
 * projects. The control plane holds the credential, so the model never sees
 * a token. Every comment carries this agent's footer, which is also what
 * jira_edit_own_comment checks ownership against. Issue text reaches the
 * model as a tool result, which the engine fences as untrusted
 * (engine-native.ts), so it is not wrapped again here. Never throws —
 * failures are JSON tool results.
 * See docs/private/2026-09-30-jira-issue-tracker-design.md.
 */
import { z } from "zod";
import type { LoadedTool } from "../providers/engine/types.js";
import { agentFooter, hasAgentFooter } from "../providers/issue-tracker/jira.js";
import {
  ISSUE_KEY,
  IssueTrackerError,
  projectOf,
  type IssueTracker,
  type IssueTrackerRegistry,
} from "../providers/issue-tracker/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "issue-tracker-tools" });

export interface IssueProjectLink {
  provider: "jira";
  projectKey: string;
  access: "read" | "write";
  commentVisibilityRole: string | null;
}

export interface IssueToolContext {
  agentId: string;
  links: readonly IssueProjectLink[];
  trackers: IssueTrackerRegistry;
  /** Live re-read of the link (null = unlinked since load). */
  currentLink: (projectKey: string) => Promise<IssueProjectLink | null>;
}

const IssueKey = z.string().regex(ISSUE_KEY, "must be an issue key such as PROJ-123");
const Body = z.string().min(1).max(20_000);

const GetIssueArgs = z.object({ issueKey: IssueKey, maxComments: z.number().int().min(1).max(50).optional() }).strict();
const SearchArgs = z
  .object({ jql: z.string().min(1).max(2000), maxResults: z.number().int().min(1).max(50).optional() })
  .strict();
const CommentArgs = z.object({ issueKey: IssueKey, body: Body }).strict();
const EditOwnCommentArgs = z
  .object({
    issueKey: IssueKey,
    commentId: z.string().regex(/^\d{1,20}$/),
    body: Body,
  })
  .strict();

const ISSUE_KEY_PROP = {
  type: "string",
  pattern: ISSUE_KEY.source,
  description: 'The issue key, e.g. "PROJ-123"; its project must be one this agent is linked to.',
};

const POSTING =
  "You post as this deployment's Jira service account; your comment ends with a footer naming this agent. " +
  "The body is a Markdown subset: paragraphs, # to ### headings, - or 1. lists, > quotes, ``` code blocks, " +
  "**bold**, _italic_, `code`, and [text](https://...) links. Anything else is posted as plain text, and " +
  "@ never mentions or notifies anyone.";

export const ISSUE_TRACKER_TOOL_DEFS: LoadedTool[] = [
  {
    name: "jira_get_issue",
    description:
      "Reads a Jira issue: summary, description (plain text), status, type, priority, labels, assignee, reporter, url, and its most recent comments (oldest first; commentsTruncated says whether older ones were left out). Comments you wrote on this issue are marked byThisAgent and can be edited with jira_edit_own_comment.",
    jsonSchema: {
      type: "object",
      properties: {
        issueKey: ISSUE_KEY_PROP,
        maxComments: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." },
      },
      required: ["issueKey"],
      additionalProperties: false,
    },
  },
  {
    name: "jira_search",
    description:
      'Searches Jira issues with JQL, limited to the projects this agent is linked to (your JQL is combined as `project in (...) AND (<your JQL>)`; a trailing ORDER BY is kept). Returns each issue\'s key, summary, status, type, updated time, and url; truncated says whether more matched. Example: `status = "In Progress" ORDER BY updated DESC`.',
    jsonSchema: {
      type: "object",
      properties: {
        jql: { type: "string", minLength: 1, maxLength: 2000 },
        maxResults: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
      },
      required: ["jql"],
      additionalProperties: false,
    },
  },
  {
    name: "jira_comment",
    description: `Posts a comment on a Jira issue in a project this agent is linked to with write access. ${POSTING} Returns the comment's id and url.`,
    jsonSchema: {
      type: "object",
      properties: {
        issueKey: ISSUE_KEY_PROP,
        body: { type: "string", minLength: 1, maxLength: 20000 },
      },
      required: ["issueKey", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "jira_edit_own_comment",
    description: `Replaces the text of a comment this agent posted earlier (one jira_get_issue marks byThisAgent); any other comment is refused. ${POSTING}`,
    jsonSchema: {
      type: "object",
      properties: {
        issueKey: ISSUE_KEY_PROP,
        commentId: { type: "string", pattern: "^\\d{1,20}$" },
        body: { type: "string", minLength: 1, maxLength: 20000 },
      },
      required: ["issueKey", "commentId", "body"],
      additionalProperties: false,
    },
  },
];

export const ISSUE_TRACKER_TOOL_NAMES: ReadonlySet<string> = new Set(ISSUE_TRACKER_TOOL_DEFS.map((t) => t.name));
const WRITE_TOOLS: ReadonlySet<string> = new Set(["jira_comment", "jira_edit_own_comment"]);

/**
 * Restricts the model's JQL to `projectKeys`: `project in (...) AND (<filter>)`,
 * with a top-level trailing ORDER BY kept outside the parentheses. Returns
 * null when the JQL could close the wrapping parenthesis itself (unbalanced
 * parentheses outside quoted strings, an unterminated string, or a
 * parenthesis after ORDER BY): since AND binds tighter than OR, a filter
 * like `x) OR (y` would otherwise escape the project scope.
 */
export function scopeJql(projectKeys: readonly string[], jql: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  let orderAt = -1;
  for (let i = 0; i < jql.length; i++) {
    const c = jql[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === ")") {
      if (orderAt >= 0) return null;
      depth += c === "(" ? 1 : -1;
      if (depth < 0) return null;
    } else if (
      orderAt < 0 &&
      depth === 0 &&
      (c === "o" || c === "O") &&
      (i === 0 || /[\s)]/.test(jql[i - 1])) &&
      /^order\s+by\b/i.test(jql.slice(i))
    ) {
      orderAt = i;
    }
  }
  if (quote || depth !== 0) return null;
  const filter = (orderAt < 0 ? jql : jql.slice(0, orderAt)).trim();
  const order = orderAt < 0 ? "" : jql.slice(orderAt).trim();
  return `project in (${projectKeys.join(", ")})${filter ? ` AND (${filter})` : ""}${order ? ` ${order}` : ""}`;
}

function error(code: string, message: string = code): string {
  return JSON.stringify({ error: code, message });
}

const commentUrl = (tracker: IssueTracker, issueKey: string, commentId: string): string =>
  `${tracker.issueUrl(issueKey)}?focusedCommentId=${commentId}`;

/** The link's project, if it is loaded, still linked, and (for a write tool) still writable; else the refusal. */
async function authorizeProject(
  name: string,
  projectKey: string,
  ctx: IssueToolContext,
): Promise<{ link: IssueProjectLink } | { refusal: string }> {
  const loaded = ctx.links.find((l) => l.projectKey === projectKey);
  if (!loaded)
    return { refusal: error("project_not_linked", `This agent is not linked to Jira project ${projectKey}.`) };
  if (WRITE_TOOLS.has(name) && loaded.access !== "write") {
    return { refusal: error("write_access_required", `This agent's link to ${projectKey} is read-only.`) };
  }
  // Live, not from the pinned load: an unlink or downgrade takes effect on the very next call.
  const current = await ctx.currentLink(projectKey);
  if (!current) return { refusal: error("project_not_linked", `This agent is no longer linked to ${projectKey}.`) };
  if (WRITE_TOOLS.has(name) && current.access !== "write") {
    return { refusal: error("write_access_required", `This agent's link to ${projectKey} is read-only.`) };
  }
  return { link: current };
}

/**
 * Dispatches one built-in jira_* tool call. Never throws — mirrors
 * runner.ts's `runSandboxTool` contract: a failure becomes a JSON error
 * result fed back to the model as the tool's result.
 */
export async function handleIssueTrackerTool(name: string, argsJson: string, ctx: IssueToolContext): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson || "{}");
  } catch (err) {
    return error("invalid_arguments_json", err instanceof Error ? err.message : String(err));
  }
  try {
    if (name === "jira_search") {
      const a = SearchArgs.parse(parsed);
      const current: IssueProjectLink[] = [];
      for (const loaded of ctx.links) {
        const link = await ctx.currentLink(loaded.projectKey);
        if (link) current.push(link);
      }
      if (current.length === 0) return error("project_not_linked", "This agent is no longer linked to any project.");
      const tracker = ctx.trackers.jira;
      if (!tracker) return error("tracker_not_configured", "No Jira site is configured on this deployment.");
      const jql = scopeJql(
        current.map((l) => l.projectKey),
        a.jql,
      );
      if (!jql) {
        return error("invalid_arguments", "jql: unbalanced parentheses or quotes, or a parenthesis after ORDER BY.");
      }
      return JSON.stringify(await tracker.search(jql, { maxResults: a.maxResults ?? 20 }));
    }

    const a =
      name === "jira_get_issue"
        ? GetIssueArgs.parse(parsed)
        : name === "jira_comment"
          ? CommentArgs.parse(parsed)
          : name === "jira_edit_own_comment"
            ? EditOwnCommentArgs.parse(parsed)
            : null;
    if (!a) return error("unknown_tool", `No built-in tool named "${name}".`);
    const authorized = await authorizeProject(name, projectOf(a.issueKey), ctx);
    if ("refusal" in authorized) return authorized.refusal;
    const { link } = authorized;
    const tracker = ctx.trackers[link.provider];
    if (!tracker) return error("tracker_not_configured", `No ${link.provider} site is configured on this deployment.`);

    switch (name) {
      case "jira_get_issue": {
        const { issueKey, maxComments } = a as z.infer<typeof GetIssueArgs>;
        return JSON.stringify(
          await tracker.getIssue(issueKey, { maxComments: maxComments ?? 10, agentMarker: ctx.agentId }),
        );
      }
      case "jira_comment": {
        const { issueKey, body } = a as z.infer<typeof CommentArgs>;
        const posted = await tracker.comment(issueKey, {
          markdown: `${body}\n\n${agentFooter(ctx.agentId)}`,
          ...(link.commentVisibilityRole ? { visibilityRole: link.commentVisibilityRole } : {}),
        });
        return JSON.stringify({ id: posted.id, url: posted.url });
      }
      default: {
        const { issueKey, commentId, body } = a as z.infer<typeof EditOwnCommentArgs>;
        const existing = await tracker.readComment(issueKey, commentId);
        if (!existing) return error("tracker_not_found", `No comment ${commentId} on ${issueKey}.`);
        // Both: the bot wrote it, and it carries THIS agent's footer (other agents share the bot).
        const own =
          existing.authorId !== null &&
          existing.authorId === (await tracker.botAccountId()) &&
          hasAgentFooter(existing.body, ctx.agentId);
        if (!own) return error("not_own_comment", "Only comments this agent posted can be edited.");
        await tracker.editComment(issueKey, commentId, { markdown: `${body}\n\n${agentFooter(ctx.agentId)}` });
        return JSON.stringify({ id: commentId, url: commentUrl(tracker, issueKey, commentId) });
      }
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return error(
        "invalid_arguments",
        err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
      );
    }
    if (err instanceof IssueTrackerError) return error(err.code, err.message);
    log.warn({ err, agentId: ctx.agentId, tool: name }, "issue tracker tool failed");
    return error("tracker_api_error", "The issue tracker request failed.");
  }
}
