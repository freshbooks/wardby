import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerModelTools } from "./models.js";
import { RoutingLlmProvider, SHIPPED_CATALOG, buildCatalog } from "../../providers/llm/index.js";
import type { LlmProvider } from "../../providers/llm/types.js";
import type { CatalogLlmAdapter } from "../../providers/llm/routing.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";

function fakeLlm(name: string): CatalogLlmAdapter {
  const self: CatalogLlmAdapter = {
    async *stream() {
      yield { type: "done", stopReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
    async countTokens() {
      return name.length;
    },
    priceUsd() {
      return 0;
    },
    withEntry: () => self,
  };
  return self;
}

function fakeCtx(llm: LlmProvider): McpRequestContext {
  return {
    principal: { id: "p1", subject: "p1", createdAt: new Date() },
    scopes: new Set(["agents:read"]),
    canonicalUri: CANONICAL_URI,
    providers: { llm } as unknown as McpRequestContext["providers"],
    db: {} as never,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("list_models", () => {
  it("returns every catalog model whose provider is configured", async () => {
    const llm = new RoutingLlmProvider(
      [
        { provider: "openai", adapter: fakeLlm("a") },
        { provider: "anthropic", adapter: fakeLlm("b") },
      ],
      () => buildCatalog(SHIPPED_CATALOG, [], "2026-10-03"),
    );
    const mcp = buildMcpServer({
      providers: { llm } as unknown as McpRequestContext["providers"],
      db: {} as never,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(llm));
    registerModelTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_models", arguments: {} });
    expect(result.isError).toBeFalsy();
    const { models } = JSON.parse((result.content as { text: string }[])[0].text);
    const expected = SHIPPED_CATALOG.filter((e) => e.provider !== "bedrock-claude").map((e) => e.modelId);
    expect(models.sort()).toEqual(expected.sort());

    await client.close();
  });
});
