import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerNotificationChannelTools } from "./notification-channels.js";
import { FakeChatProvider } from "../../providers/chat/fake.js";
import { ChatError } from "../../providers/chat/types.js";
import type { McpRequestContext, McpProviders } from "../context.js";

const CANONICAL_URI = "https://host/mcp";

interface FakeAgentRow {
  id: string;
  ownerId: string | null;
}

interface ChannelRow {
  id: string;
  provider: string;
  channelId: string;
  channelName: string | null;
  issueProvider: string | null;
  projectKey: string | null;
  agentId: string | null;
  events: string[];
  includeCost: boolean;
  lastError: string | null;
  lastErrorAt: Date | null;
  authorizedById: string;
  authorizedAt: Date;
  createdAt: Date;
}

interface DeliveryRow {
  channelId: string;
  state: string;
}

function matches(row: ChannelRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, value]) => (row as unknown as Record<string, unknown>)[field] === value);
}

function fakeDb(agents: FakeAgentRow[], links: ChannelRow[] = [], deliveries: DeliveryRow[] = []) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const rows: ChannelRow[] = links.map((l) => ({ ...l }));
  let nextId = rows.length + 1;
  const db = {
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
      findMany: async () => [],
    },
    resourceGrant: { findMany: async () => [], findFirst: async () => null },
    notificationChannel: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        rows.filter((r) => matches(r, where ?? {})).map((r) => ({ ...r })),
      create: async ({ data }: { data: Partial<ChannelRow> }) => {
        const row: ChannelRow = {
          id: `l${nextId++}`,
          channelName: null,
          issueProvider: null,
          projectKey: null,
          agentId: null,
          events: [],
          includeCost: false,
          lastError: null,
          lastErrorAt: null,
          createdAt: new Date(),
          ...data,
        } as ChannelRow;
        rows.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ChannelRow> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const before = rows.length;
        const kept = rows.filter((r) => r.id !== where.id);
        rows.length = 0;
        rows.push(...kept);
        return { count: before - kept.length };
      },
    },
    notificationDelivery: {
      groupBy: async ({ where }: { where?: { state?: { in: string[] } } } = {}) => {
        const allowed = where?.state?.in;
        const counts = new Map<string, number>();
        for (const d of deliveries) {
          if (allowed && !allowed.includes(d.state)) continue;
          const key = `${d.channelId}|${d.state}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()].map(([key, _count]) => {
          const [channelId, state] = key.split("|");
          return { channelId, state, _count };
        });
      },
    },
  };
  return { db: db as unknown as import("#prisma").PrismaClient, rows, deliveries };
}

const NATIVE: FakeAgentRow = { id: "a1", ownerId: "owner1" };

async function setup(
  agents: FakeAgentRow[],
  opts: {
    roles?: string[];
    scopes?: string[];
    chat?: boolean;
    links?: ChannelRow[];
    deliveries?: DeliveryRow[];
    principalId?: string;
  } = {},
) {
  const { db, rows, deliveries } = fakeDb(agents, opts.links, opts.deliveries);
  const chatProvider = new FakeChatProvider();
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: CANONICAL_URI } });
  const principalId = opts.principalId ?? "admin1";
  const ctx: McpRequestContext = {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(opts.scopes ?? ["agents:read", "agents:write", "agents:admin"]),
    roles: opts.roles ?? ["admin"],
    canonicalUri: CANONICAL_URI,
    providers: (opts.chat === false ? {} : { chat: { slack: chatProvider } }) as unknown as McpProviders,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerNotificationChannelTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return { client, rows, deliveries, chatProvider };
}

type Res = { isError?: boolean; content: { text: string }[] };
const text = (r: unknown) => (r as Res).content[0].text;
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<Res>;

describe("notification channel tools", () => {
  it("describes the trust model", async () => {
    const { client } = await setup([NATIVE]);
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "link_notification_channel")!.description!;
    expect(d).toMatch(/admin/i);
    expect(d).toMatch(/outbound only/i);
    expect(d).toMatch(/\/invite/);
  });

  it("rejects an admin scope without the admin role, for link, unlink, and test", async () => {
    const { client } = await setup([NATIVE], { roles: [] });
    const r1 = await call(client, "link_notification_channel", { channel: "C123ABCDEF", projectKey: "PAY" });
    expect(r1.isError).toBeTruthy();
    const r2 = await call(client, "unlink_notification_channel", { id: "l1" });
    expect(r2.isError).toBeTruthy();
    const r3 = await call(client, "test_notification_channel", { id: "l1" });
    expect(r3.isError).toBeTruthy();
  });

  it("fails when Slack is not configured", async () => {
    const { client, rows } = await setup([NATIVE], { chat: false });
    const r = await call(client, "link_notification_channel", { channel: "C123ABCDEF", projectKey: "PAY" });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toContain(
      "Slack is not configured (WARDBY_SLACK_BOT_TOKEN). See help article errors/slack-not-configured.",
    );
    expect(rows).toHaveLength(0);
  });

  it("requires exactly one of projectKey or agentId", async () => {
    const { client, rows, chatProvider } = await setup([NATIVE]);
    chatProvider.channels.set("C123ABCDEF", { id: "C123ABCDEF", name: "eng", isPrivate: false });
    const neither = await call(client, "link_notification_channel", { channel: "C123ABCDEF" });
    expect(neither.isError).toBeTruthy();
    expect(text(neither)).toContain("Give exactly one of projectKey or agentId.");
    const both = await call(client, "link_notification_channel", {
      channel: "C123ABCDEF",
      projectKey: "PAY",
      agentId: "a1",
    });
    expect(both.isError).toBeTruthy();
    expect(text(both)).toContain("Give exactly one of projectKey or agentId.");
    expect(rows).toHaveLength(0);
  });

  it("rejects a bad channel id (a #name)", async () => {
    const { client, rows } = await setup([NATIVE]);
    const r = await call(client, "link_notification_channel", { channel: "#eng", projectKey: "PAY" });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toContain("Pass the channel id (C…); find it in the channel's details in Slack.");
    expect(rows).toHaveLength(0);
  });

  it("rejects an unknown agentId with 404", async () => {
    const { client, rows } = await setup([NATIVE]);
    const r = await call(client, "link_notification_channel", { channel: "C123ABCDEF", agentId: "zz" });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toMatch(/not found/);
    expect(rows).toHaveLength(0);
  });

  it("rejects a channel the bot cannot see, with an invite hint", async () => {
    const { client, rows } = await setup([NATIVE]);
    const r = await call(client, "link_notification_channel", { channel: "C123ABCDEF", projectKey: "PAY" });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toContain("The bot cannot see channel C123ABCDEF");
    expect(text(r)).toContain("/invite @<app>");
    expect(text(r)).toContain("errors/slack-channel-unreachable");
    expect(rows).toHaveLength(0);
  });

  it("accepts the channel id with no name when channelInfo is auth_failed", async () => {
    const { client, rows, chatProvider } = await setup([NATIVE]);
    chatProvider.failNext("channelInfo", new ChatError("auth_failed", "missing_scope"));
    const r = await call(client, "link_notification_channel", { channel: "C123ABCDEF", projectKey: "PAY" });
    expect(r.isError).toBeFalsy();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelId: "C123ABCDEF", channelName: null, projectKey: "PAY" });
  });

  it("links a project channel, upper-casing the channel and project key, and stamping the authorizer", async () => {
    const { client, rows, chatProvider } = await setup([NATIVE]);
    chatProvider.channels.set("C123ABCDEF", { id: "C123ABCDEF", name: "eng-pay", isPrivate: false });
    const r = await call(client, "link_notification_channel", {
      channel: "c123abcdef",
      projectKey: "pay",
      events: ["pr_opened"],
    });
    expect(r.isError).toBeFalsy();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "slack",
      channelId: "C123ABCDEF",
      channelName: "eng-pay",
      issueProvider: "jira",
      projectKey: "PAY",
      agentId: null,
      events: ["pr_opened"],
      includeCost: false,
      authorizedById: "admin1",
    });
    expect(rows[0].authorizedAt).toBeInstanceOf(Date);
  });

  it("links an agent channel", async () => {
    const { client, rows, chatProvider } = await setup([NATIVE]);
    chatProvider.channels.set("CAGENT0001", { id: "CAGENT0001", name: "agent-ch", isPrivate: false });
    const r = await call(client, "link_notification_channel", { channel: "CAGENT0001", agentId: "a1" });
    expect(r.isError).toBeFalsy();
    expect(rows[0]).toMatchObject({ agentId: "a1", projectKey: null, issueProvider: null });
  });

  it("upserts on re-link: replaces events and includeCost, and clears a recorded lastError", async () => {
    const { client, rows, chatProvider } = await setup([NATIVE], {
      links: [
        {
          id: "l1",
          provider: "slack",
          channelId: "C123ABCDEF",
          channelName: "old-name",
          issueProvider: "jira",
          projectKey: "PAY",
          agentId: null,
          events: ["run_failed"],
          includeCost: true,
          lastError: "not_in_channel",
          lastErrorAt: new Date("2026-01-01"),
          authorizedById: "someone-else",
          authorizedAt: new Date("2026-01-01"),
          createdAt: new Date("2026-01-01"),
        },
      ],
    });
    chatProvider.channels.set("C123ABCDEF", { id: "C123ABCDEF", name: "eng-pay", isPrivate: false });
    const r = await call(client, "link_notification_channel", {
      channel: "C123ABCDEF",
      projectKey: "PAY",
      events: ["pr_opened", "pr_closed"],
      includeCost: false,
    });
    expect(r.isError).toBeFalsy();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "l1",
      events: ["pr_opened", "pr_closed"],
      includeCost: false,
      lastError: null,
      lastErrorAt: null,
      channelName: "eng-pay",
      authorizedById: "admin1",
    });
  });

  it("unlinks by id", async () => {
    const { client, rows } = await setup([NATIVE], {
      links: [
        {
          id: "l1",
          provider: "slack",
          channelId: "C123ABCDEF",
          channelName: null,
          issueProvider: "jira",
          projectKey: "PAY",
          agentId: null,
          events: [],
          includeCost: false,
          lastError: null,
          lastErrorAt: null,
          authorizedById: "admin1",
          authorizedAt: new Date(),
          createdAt: new Date(),
        },
      ],
    });
    const r = await call(client, "unlink_notification_channel", { id: "l1" });
    expect(JSON.parse(text(r))).toEqual({ unlinked: true });
    expect(rows).toHaveLength(0);
    const r2 = await call(client, "unlink_notification_channel", { id: "l1" });
    expect(JSON.parse(text(r2))).toEqual({ unlinked: false });
  });

  const PROJECT_LINK: ChannelRow = {
    id: "l1",
    provider: "slack",
    channelId: "C123ABCDEF",
    channelName: "eng-pay",
    issueProvider: "jira",
    projectKey: "PAY",
    agentId: null,
    events: [],
    includeCost: false,
    lastError: null,
    lastErrorAt: null,
    authorizedById: "admin1",
    authorizedAt: new Date(),
    createdAt: new Date(),
  };

  const AGENT_LINK: ChannelRow = {
    ...PROJECT_LINK,
    id: "l2",
    channelId: "CAGENT0001",
    issueProvider: null,
    projectKey: null,
    agentId: "a1",
  };

  it("lists with agentId for an owner, with pending/failed counts", async () => {
    const { client } = await setup([{ id: "a1", ownerId: "admin1" }], {
      roles: [],
      scopes: ["agents:read"],
      links: [PROJECT_LINK, AGENT_LINK],
      deliveries: [
        { channelId: "CAGENT0001", state: "pending" },
        { channelId: "CAGENT0001", state: "pending" },
        { channelId: "CAGENT0001", state: "failed" },
        { channelId: "CAGENT0001", state: "delivered" },
        { channelId: "C123ABCDEF", state: "failed" },
      ],
    });
    const r = await call(client, "list_notification_channels", { agentId: "a1" });
    expect(r.isError).toBeFalsy();
    const listed = JSON.parse(text(r)) as { channels: { channelId: string; pending: number; failed: number }[] };
    expect(listed.channels).toHaveLength(1);
    expect(listed.channels[0]).toMatchObject({ channelId: "CAGENT0001", pending: 2, failed: 1 });
  });

  it("needs admin to list without an agentId", async () => {
    const { client } = await setup([NATIVE], { roles: [], scopes: ["agents:read"], links: [PROJECT_LINK] });
    const r = await call(client, "list_notification_channels", {});
    expect(r.isError).toBeTruthy();
  });

  it("lists every link for an admin, filtered by projectKey", async () => {
    const { client } = await setup([NATIVE], { links: [PROJECT_LINK, AGENT_LINK] });
    const r = await call(client, "list_notification_channels", { projectKey: "pay" });
    const listed = JSON.parse(text(r)) as { channels: { id: string }[] };
    expect(listed.channels.map((c) => c.id)).toEqual(["l1"]);
  });

  it("posts a test message once and reports success", async () => {
    const { client, chatProvider } = await setup([NATIVE], { links: [PROJECT_LINK] });
    const r = await call(client, "test_notification_channel", { id: "l1" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ tested: true });
    expect(chatProvider.posts).toHaveLength(1);
    expect(chatProvider.posts[0]).toMatchObject({
      channelId: "C123ABCDEF",
      msg: { text: "✅ wardby is connected to this channel." },
    });
  });

  it("surfaces not_in_channel from the test tool and stamps lastError on the link", async () => {
    const { client, rows, chatProvider } = await setup([NATIVE], { links: [PROJECT_LINK] });
    chatProvider.failNext("postMessage", new ChatError("channel_unreachable", "not_in_channel"));
    const r = await call(client, "test_notification_channel", { id: "l1" });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toContain("channel_unreachable: not_in_channel");
    expect(chatProvider.posts).toHaveLength(0);
    expect(rows[0].lastError).toBe("not_in_channel");
    expect(rows[0].lastErrorAt).toBeInstanceOf(Date);
  });

  it("surfaces a non-channel ChatError from the test tool without stamping lastError", async () => {
    const { client, rows, chatProvider } = await setup([NATIVE], { links: [PROJECT_LINK] });
    chatProvider.failNext("postMessage", new ChatError("rate_limited", "ratelimited", 1000));
    const r = await call(client, "test_notification_channel", { id: "l1" });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toContain("rate_limited: ratelimited");
    expect(rows[0].lastError).toBeNull();
  });

  it("404s on an unknown link id for unlink and test", async () => {
    const { client } = await setup([NATIVE]);
    const r = await call(client, "test_notification_channel", { id: "zz" });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toMatch(/not found/);
  });
});
