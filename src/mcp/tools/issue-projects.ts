/**
 * AgentIssueProject CRUD — which Jira projects a native agent may act on,
 * and which issue events trigger it. Linking is admin-approved: wardby cannot
 * verify an agent owner's own Jira access (the integration is one service
 * account, no per-user OAuth), so link/unlink need agents:admin with the
 * admin role, and the approver is stamped on the link. Triggers that carry
 * text from a person (mention/assigned) are gated by trustedAccountIds.
 * See docs/private/2026-09-30-jira-issue-tracker-design.md.
 */
import { requireAgentAccess } from "../auth/access.js";
import { requireScope } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { ISSUE_TRACKER_PROVIDERS, PROJECT_KEY } from "../../providers/issue-tracker/types.js";
import { textResult } from "./text-result.js";

const PROVIDERS = [...ISSUE_TRACKER_PROVIDERS];
const TRIGGERS = ["created", "transitioned", "labeled", "assigned", "mention"] as const;
type Trigger = (typeof TRIGGERS)[number];
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

type LinkArgs = {
  agentId: string;
  provider?: (typeof PROVIDERS)[number];
  projectKey: string;
  access: "read" | "write";
  triggers?: Trigger[];
  triggerStatuses?: string[];
  triggerLabels?: string[];
  jqlFilter?: string;
  trustedAccountIds?: string[];
  commentVisibilityRole?: string;
};

function normalizeProjectKey(projectKey: string): string {
  const key = projectKey.trim().toUpperCase();
  if (!PROJECT_KEY.test(key)) throw new McpError(400, `invalid projectKey "${projectKey}"`);
  return key;
}

export function registerIssueProjectTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "link_issue_project",
    scope: "agents:write",
    description:
      "Links a native agent to a Jira project, with its access and issue-event triggers. A wardby admin approves Jira links " +
      "(agents:admin with the admin role); the agent acts as the deployment's Jira service account, not as any person. " +
      "triggers (write access only): created, transitioned (needs triggerStatuses), labeled (needs triggerLabels), assigned and " +
      "mention (each needs trustedAccountIds). trustedAccountIds are Jira accountIds (from a Jira profile URL or jira_get_issue " +
      "output) whose mentions/assignments may trigger the agent; triggered text from anyone else is treated as untrusted. " +
      "jqlFilter optionally narrows which issues trigger; commentVisibilityRole restricts the agent's comments to a project role. " +
      "Re-linking a project replaces its access, triggers, and filters (an omitted field is cleared, not kept) — always send " +
      "the full desired state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        provider: { type: "string", enum: PROVIDERS },
        projectKey: { type: "string", minLength: 1, maxLength: 255 },
        access: { type: "string", enum: ["read", "write"] },
        triggers: { type: "array", items: { type: "string", enum: [...TRIGGERS] }, uniqueItems: true },
        triggerStatuses: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 50 },
        triggerLabels: { type: "array", items: { type: "string", minLength: 1, maxLength: 255 }, maxItems: 50 },
        jqlFilter: { type: "string", minLength: 1, maxLength: 1000 },
        trustedAccountIds: {
          type: "array",
          items: { type: "string", pattern: ACCOUNT_ID.source },
          maxItems: 50,
        },
        commentVisibilityRole: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["agentId", "projectKey", "access"],
    },
    handler: async (args: LinkArgs, ctx) => {
      requireScope(ctx, ctx.canonicalUri, "agents:admin");
      const agent = await ctx.db.agent.findUnique({ where: { id: args.agentId } });
      if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
      if (agent.kind !== "native") throw new McpError(400, "Issue-project links are for native agents only.");
      if (agent.ownerId === null) {
        throw new McpError(400, `Agent "${agent.id}" has no owner; assign one with make_owner before linking.`);
      }
      const provider = args.provider ?? "jira";
      const projectKey = normalizeProjectKey(args.projectKey);
      const triggers = [...new Set(args.triggers ?? [])];
      const triggerStatuses = args.triggerStatuses ?? [];
      const triggerLabels = args.triggerLabels ?? [];
      const trustedAccountIds = [...new Set(args.trustedAccountIds ?? [])];
      if (trustedAccountIds.some((id) => !ACCOUNT_ID.test(id))) {
        throw new McpError(
          400,
          "invalid trustedAccountIds entry (letters, digits, ':', '_', '-'; up to 128 characters)",
        );
      }
      if (triggers.length > 0 && args.access !== "write") throw new McpError(400, "Event triggers need write access.");
      if (triggers.includes("transitioned") && triggerStatuses.length === 0) {
        throw new McpError(400, "The transitioned trigger needs a non-empty triggerStatuses.");
      }
      if (triggers.includes("labeled") && triggerLabels.length === 0) {
        throw new McpError(400, "The labeled trigger needs a non-empty triggerLabels.");
      }
      if ((triggers.includes("mention") || triggers.includes("assigned")) && trustedAccountIds.length === 0) {
        throw new McpError(400, "The mention and assigned triggers need a non-empty trustedAccountIds.");
      }
      if (!ctx.providers.issueTrackers?.[provider]) {
        throw new McpError(503, "Jira is not configured on this deployment (see docs/jira-agents.md).");
      }
      const fields = {
        access: args.access,
        triggers,
        triggerStatuses,
        triggerLabels,
        jqlFilter: args.jqlFilter ?? null,
        trustedAccountIds,
        commentVisibilityRole: args.commentVisibilityRole ?? null,
        authorizedById: ctx.principal.id,
        authorizedAt: new Date(),
      };
      const link = await ctx.db.agentIssueProject.upsert({
        where: { agentId_provider_projectKey: { agentId: args.agentId, provider, projectKey } },
        create: { agentId: args.agentId, provider, projectKey, ...fields },
        update: fields,
      });
      return textResult({ linked: true, link });
    },
  });

  mcp.registerTool({
    name: "unlink_issue_project",
    scope: "agents:write",
    description: "Removes a native agent's link to a Jira project. Admin only (agents:admin with the admin role).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        provider: { type: "string", enum: PROVIDERS },
        projectKey: { type: "string", minLength: 1, maxLength: 255 },
      },
      required: ["agentId", "projectKey"],
    },
    handler: async (args: { agentId: string; provider?: string; projectKey: string }, ctx) => {
      requireScope(ctx, ctx.canonicalUri, "agents:admin");
      const agent = await ctx.db.agent.findUnique({ where: { id: args.agentId } });
      if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
      const { count } = await ctx.db.agentIssueProject.deleteMany({
        where: {
          agentId: args.agentId,
          provider: args.provider ?? "jira",
          projectKey: normalizeProjectKey(args.projectKey),
        },
      });
      return textResult({ unlinked: count > 0 });
    },
  });

  mcp.registerTool({
    name: "list_issue_projects",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
    handler: async (args: { agentId: string }, ctx) => {
      await requireAgentAccess(ctx, args.agentId, "read");
      const links = await ctx.db.agentIssueProject.findMany({
        where: { agentId: args.agentId },
        orderBy: { createdAt: "asc" },
      });
      return textResult({ issueProjects: links });
    },
  });
}
