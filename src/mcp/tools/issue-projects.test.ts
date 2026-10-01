import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerIssueProjectTools } from "./issue-projects.js";
import type { McpRequestContext, McpProviders } from "../context.js";

const CANONICAL_URI = "https://host/mcp";

interface FakeAgentRow {
  id: string;
  name: string;
  ownerId: string | null;
  kind: "native" | "coding";
}
type Row = Record<string, unknown> & { agentId: string; provider: string; projectKey: string };

function fakeDb(agents: FakeAgentRow[], links: Row[] = []) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const rows: Row[] = [...links];
  const db = {
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
      findMany: async () => [],
    },
    resourceGrant: { findMany: async () => [], findFirst: async () => null },
    agentIssueProject: {
      findMany: async ({ where }: { where: { agentId: string } }) =>
        rows.filter((r) => r.agentId === where.agentId).map((r) => ({ ...r })),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { agentId_provider_projectKey: { agentId: string; provider: string; projectKey: string } };
        create: Row;
        update: Partial<Row>;
      }) => {
        const k = where.agentId_provider_projectKey;
        const existing = rows.find(
          (r) => r.agentId === k.agentId && r.provider === k.provider && r.projectKey === k.projectKey,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: `l${rows.length + 1}`, createdAt: new Date(), ...create };
        rows.push(row);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: { agentId: string; provider: string; projectKey: string } }) => {
        const before = rows.length;
        const kept = rows.filter(
          (r) => !(r.agentId === where.agentId && r.provider === where.provider && r.projectKey === where.projectKey),
        );
        rows.length = 0;
        rows.push(...kept);
        return { count: before - kept.length };
      },
    },
  };
  return { db: db as unknown as import("#prisma").PrismaClient, rows };
}

const NATIVE: FakeAgentRow = { id: "a1", name: "triager", ownerId: "owner1", kind: "native" };

async function setup(
  agents: FakeAgentRow[],
  opts: { roles?: string[]; scopes?: string[]; jira?: boolean; links?: Row[] } = {},
) {
  const { db, rows } = fakeDb(agents, opts.links);
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: CANONICAL_URI } });
  const ctx: McpRequestContext = {
    principal: { id: "admin1", subject: "admin1", createdAt: new Date() },
    scopes: new Set(opts.scopes ?? ["agents:read", "agents:write", "agents:admin"]),
    roles: opts.roles ?? ["admin"],
    canonicalUri: CANONICAL_URI,
    providers: (opts.jira === false ? {} : { issueTrackers: { jira: {} } }) as unknown as McpProviders,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerIssueProjectTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return { client, rows };
}

type Res = { isError?: boolean; content: { text: string }[] };
const text = (r: unknown) => (r as Res).content[0].text;
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<Res>;

describe("issue project tools", () => {
  it("describes the trust model", async () => {
    const { client } = await setup([NATIVE]);
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "link_issue_project")!.description!;
    expect(d).toMatch(/admin/i);
    expect(d).toContain("accountId");
    expect(d).toMatch(/untrusted/i);
  });

  it("rejects a non-admin", async () => {
    const { client } = await setup([NATIVE], { roles: [], scopes: ["agents:read", "agents:write"] });
    const r = await call(client, "link_issue_project", { agentId: "a1", projectKey: "PROJ", access: "read" });
    expect(r.isError).toBeTruthy();
    const r2 = await call(client, "unlink_issue_project", { agentId: "a1", projectKey: "PROJ" });
    expect(r2.isError).toBeTruthy();
  });

  it("rejects an admin scope without the admin role", async () => {
    const { client } = await setup([NATIVE], { roles: [] });
    const r = await call(client, "link_issue_project", { agentId: "a1", projectKey: "PROJ", access: "read" });
    expect(r.isError).toBeTruthy();
  });

  it("links a write project, upper-casing the key and stamping the authorizer", async () => {
    const { client, rows } = await setup([NATIVE]);
    const r = await call(client, "link_issue_project", {
      agentId: "a1",
      projectKey: "proj",
      access: "write",
      triggers: ["created"],
    });
    expect(r.isError).toBeFalsy();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "a1",
      provider: "jira",
      projectKey: "PROJ",
      access: "write",
      triggers: ["created"],
      authorizedById: "admin1",
    });
    expect(rows[0].authorizedAt).toBeInstanceOf(Date);
    // full-state replace
    await call(client, "link_issue_project", { agentId: "a1", projectKey: "PROJ", access: "read" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ access: "read", triggers: [] });
  });

  it.each([
    ["mention without trusted accounts", { triggers: ["mention"] }, /trustedAccountIds/],
    ["assigned without trusted accounts", { triggers: ["assigned"] }, /trustedAccountIds/],
    ["transitioned without statuses", { triggers: ["transitioned"] }, /triggerStatuses/],
    ["labeled without labels", { triggers: ["labeled"] }, /triggerLabels/],
    ["bad projectKey", { projectKey: "1bad key" }, /projectKey/],
    ["bad account id", { triggers: ["mention"], trustedAccountIds: ["bad id!"] }, /./],
  ])("rejects %s with 400", async (_n, extra, msg) => {
    const { client, rows } = await setup([NATIVE]);
    const r = await call(client, "link_issue_project", {
      agentId: "a1",
      projectKey: "PROJ",
      access: "write",
      ...extra,
    });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toMatch(msg);
    expect(rows).toHaveLength(0);
  });

  it("rejects triggers on a read link", async () => {
    const { client } = await setup([NATIVE]);
    const r = await call(client, "link_issue_project", {
      agentId: "a1",
      projectKey: "PROJ",
      access: "read",
      triggers: ["created"],
    });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toMatch(/write access/);
  });

  it("rejects coding agents, missing agents, and owner-less agents", async () => {
    const { client } = await setup([
      { id: "c1", name: "c", ownerId: "o", kind: "coding" },
      { id: "n1", name: "n", ownerId: null, kind: "native" },
    ]);
    for (const [agentId, re] of [
      ["c1", /native agents only/],
      ["n1", /no owner/],
      ["zz", /not found/],
    ] as const) {
      const r = await call(client, "link_issue_project", { agentId, projectKey: "PROJ", access: "read" });
      expect(r.isError).toBeTruthy();
      expect(text(r)).toMatch(re);
    }
  });

  it("fails when Jira is not configured", async () => {
    const { client, rows } = await setup([NATIVE], { jira: false });
    const r = await call(client, "link_issue_project", { agentId: "a1", projectKey: "PROJ", access: "read" });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toContain("Jira is not configured on this deployment (see docs/jira-agents.md)");
    expect(rows).toHaveLength(0);
  });

  it("lists and unlinks", async () => {
    const { client, rows } = await setup([{ ...NATIVE, ownerId: "admin1" }]);
    await call(client, "link_issue_project", { agentId: "a1", projectKey: "PROJ", access: "read" });
    const listed = JSON.parse(text(await call(client, "list_issue_projects", { agentId: "a1" }))) as {
      issueProjects: { projectKey: string }[];
    };
    expect(listed.issueProjects.map((l) => l.projectKey)).toEqual(["PROJ"]);
    const un = JSON.parse(text(await call(client, "unlink_issue_project", { agentId: "a1", projectKey: "proj" })));
    expect(un).toEqual({ unlinked: true });
    expect(rows).toHaveLength(0);
  });

  it("stores allowlists (trimmed, de-duplicated case-insensitively) and lists them", async () => {
    const { client, rows } = await setup([{ ...NATIVE, ownerId: "admin1" }]);
    const r = await call(client, "link_issue_project", {
      agentId: "a1",
      projectKey: "PROJ",
      access: "write",
      allowedTransitions: [" In Review ", "in review", "Done"],
      writableFields: ["labels", "priority", "customfield_10042", "labels"],
      allowedLinkTypes: [" Duplicate ", "duplicate", "Blocks"],
    });
    expect(r.isError).toBeFalsy();
    expect(rows[0]).toMatchObject({
      allowedTransitions: ["In Review", "Done"],
      writableFields: ["labels", "priority", "customfield_10042"],
      allowedLinkTypes: ["Duplicate", "Blocks"],
    });
    const listed = JSON.parse(text(await call(client, "list_issue_projects", { agentId: "a1" }))) as {
      issueProjects: { allowedTransitions: string[]; writableFields: string[]; allowedLinkTypes: string[] }[];
    };
    expect(listed.issueProjects[0].allowedTransitions).toEqual(["In Review", "Done"]);
    expect(listed.issueProjects[0].writableFields).toEqual(["labels", "priority", "customfield_10042"]);
    expect(listed.issueProjects[0].allowedLinkTypes).toEqual(["Duplicate", "Blocks"]);
  });

  it.each([
    ["an unknown field id", { writableFields: ["summary"] }],
    ["a malformed custom field", { writableFields: ["customfield_abc"] }],
    ["a blank transition", { allowedTransitions: ["   "] }],
    ["a blank link type", { allowedLinkTypes: ["  "] }],
    ["an over-long link type", { allowedLinkTypes: ["x".repeat(101)] }],
    ["more than 20 link types", { allowedLinkTypes: Array.from({ length: 21 }, (_, i) => `Type ${i}`) }],
  ])("rejects %s", async (_n, extra) => {
    const { client, rows } = await setup([NATIVE]);
    const r = await call(client, "link_issue_project", {
      agentId: "a1",
      projectKey: "PROJ",
      access: "write",
      ...extra,
    });
    expect(r.isError).toBeTruthy();
    expect(rows).toHaveLength(0);
  });

  it("rejects allowlists on a read link", async () => {
    const { client, rows } = await setup([NATIVE]);
    for (const extra of [
      { allowedTransitions: ["Done"] },
      { writableFields: ["labels"] },
      { allowedLinkTypes: ["Duplicate"] },
    ]) {
      const r = await call(client, "link_issue_project", {
        agentId: "a1",
        projectKey: "PROJ",
        access: "read",
        ...extra,
      });
      expect(r.isError).toBeTruthy();
      expect(text(r)).toMatch(/write access/);
    }
    expect(rows).toHaveLength(0);
  });

  it("clears the allowlists on a re-link without them", async () => {
    const { client, rows } = await setup([NATIVE]);
    await call(client, "link_issue_project", {
      agentId: "a1",
      projectKey: "PROJ",
      access: "write",
      allowedTransitions: ["Done"],
      writableFields: ["labels"],
      allowedLinkTypes: ["Duplicate"],
    });
    await call(client, "link_issue_project", { agentId: "a1", projectKey: "PROJ", access: "write" });
    expect(rows[0]).toMatchObject({ allowedTransitions: [], writableFields: [], allowedLinkTypes: [] });
  });

  it("describes the allowlists as fail-closed", async () => {
    const { client } = await setup([NATIVE]);
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "link_issue_project")!.description!;
    expect(d).toMatch(/fail closed/i);
    expect(d).toMatch(/target status name/i);
    expect(d).toMatch(/allowedLinkTypes/);
  });

  it("stores, lists, and clears the PR statuses (trimmed)", async () => {
    const { client, rows } = await setup([{ ...NATIVE, ownerId: "admin1" }]);
    const r = await call(client, "link_issue_project", {
      agentId: "a1",
      projectKey: "PROJ",
      access: "write",
      onPullRequestOpened: " In Review ",
      onPullRequestMerged: "Done",
    });
    expect(r.isError).toBeFalsy();
    expect(rows[0]).toMatchObject({ onPullRequestOpened: "In Review", onPullRequestMerged: "Done" });
    const listed = JSON.parse(text(await call(client, "list_issue_projects", { agentId: "a1" }))) as {
      issueProjects: { onPullRequestOpened: string | null; onPullRequestMerged: string | null }[];
    };
    expect(listed.issueProjects[0]).toMatchObject({ onPullRequestOpened: "In Review", onPullRequestMerged: "Done" });
    await call(client, "link_issue_project", { agentId: "a1", projectKey: "PROJ", access: "write" });
    expect(rows[0]).toMatchObject({ onPullRequestOpened: null, onPullRequestMerged: null });
  });

  it.each([
    ["a blank opened status", { onPullRequestOpened: "   " }],
    ["an over-long merged status", { onPullRequestMerged: "x".repeat(101) }],
  ])("rejects %s", async (_n, extra) => {
    const { client, rows } = await setup([NATIVE]);
    const r = await call(client, "link_issue_project", {
      agentId: "a1",
      projectKey: "PROJ",
      access: "write",
      ...extra,
    });
    expect(r.isError).toBeTruthy();
    expect(rows).toHaveLength(0);
  });

  it("rejects PR statuses on a read link", async () => {
    const { client, rows } = await setup([NATIVE]);
    for (const extra of [{ onPullRequestOpened: "In Review" }, { onPullRequestMerged: "Done" }]) {
      const r = await call(client, "link_issue_project", {
        agentId: "a1",
        projectKey: "PROJ",
        access: "read",
        ...extra,
      });
      expect(r.isError).toBeTruthy();
      expect(text(r)).toMatch(/write access/);
    }
    expect(rows).toHaveLength(0);
  });

  it("describes the PR statuses as control-plane moves", async () => {
    const { client } = await setup([NATIVE]);
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "link_issue_project")!.description!;
    expect(d).toMatch(/onPullRequestOpened/);
    expect(d).toMatch(/not gated by allowedTransitions/);
  });
});
