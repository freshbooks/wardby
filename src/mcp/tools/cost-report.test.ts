import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

const costReportSpy = vi.hoisted(() => vi.fn());
vi.mock("../../core/cost-report.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/cost-report.js")>()),
  costReport: costReportSpy,
}));

const { registerCostReportTools } = await import("./cost-report.js");

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeAgentRow {
  id: string;
  ownerId: string | null;
}

function fakeDb(agents: FakeAgentRow[], grants: FakeGrantSeed[] = []) {
  return {
    resourceGrant: fakeResourceGrants(grants),
    agent: {
      findMany: async ({ where }: { where: { OR?: Array<{ ownerId?: string; id?: { in: string[] } }> } }) =>
        agents.filter(
          (a) =>
            !where.OR ||
            where.OR.some((c) => (c.ownerId !== undefined && a.ownerId === c.ownerId) || c.id?.in.includes(a.id)),
        ),
    },
  } as unknown as import("#prisma").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, operator = false): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(["agents:read"]),
    canonicalUri: CANONICAL_URI,
    providers: fakeProviders,
    db,
    operator,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function callCostReport(ctx: McpRequestContext, db: ReturnType<typeof fakeDb>, args: Record<string, unknown>) {
  const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext(ctx);
  registerCostReportTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "cost_report", arguments: args });
  await client.close();
  return result as { isError?: boolean; content: { text: string }[] };
}

describe("cost_report tool", () => {
  beforeEach(() => {
    costReportSpy.mockReset();
    costReportSpy.mockResolvedValue({ rows: [] });
  });

  it("passes null visibility for the stdio operator", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p2" }]);
    const result = await callCostReport(fakeCtx(db, "p1", true), db, {});
    expect(result.isError).toBeFalsy();
    expect(costReportSpy.mock.calls[0][2]).toBeNull();
  });

  it("passes the caller's owned agents and principal otherwise", async () => {
    const db = fakeDb(
      [
        { id: "a1", ownerId: "p1" },
        { id: "a2", ownerId: "p2" },
        { id: "a3", ownerId: "p2" },
      ],
      [{ resourceType: "agent", resourceId: "a2", level: "read", principalId: "p1" }],
    );
    await callCostReport(fakeCtx(db, "p1"), db, { groupBy: "agent" });
    expect(costReportSpy.mock.calls[0][1]).toMatchObject({ groupBy: "agent" });
    expect(costReportSpy.mock.calls[0][2]).toEqual({ ownedAgentIds: ["a1"], principalId: "p1" });
  });

  it("returns a tool error for invalid input", async () => {
    const db = fakeDb([]);
    const result = await callCostReport(fakeCtx(db, "p1"), db, { groupBy: "epic" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("groupBy");
    expect(costReportSpy).not.toHaveBeenCalled();
  });
});
