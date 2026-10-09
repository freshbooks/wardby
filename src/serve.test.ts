import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "./core/db.js";
import type { Executor } from "./providers/executor/types.js";
import type { McpProviders } from "./mcp/context.js";
import { FakeChatProvider } from "./providers/chat/fake.js";
import { startServe } from "./serve.js";

// `startNotifications` is mocked (least-invasive seam) so this file can
// assert serve.ts wires `providers.chat` through to it, and calls its
// returned `stop()` during `close()`, without exercising the real
// lease-gated dispatcher (already covered by notifications.test.ts).
const notificationsMock = vi.hoisted(() => ({
  startNotifications: vi.fn(async () => ({ stop: vi.fn() })),
}));
vi.mock("./core/notifications.js", () => notificationsMock);

const ENV_KEYS = [
  "MCP_TRANSPORT",
  "MCP_HTTP_BIND",
  "MCP_CANONICAL_URI",
  "AUTH_PROVIDER",
  "AUTH_AUDIENCE",
  "AUTH_SIGNING_KEY",
  "AUTH_CREDENTIAL_HASH_KEY",
  "SECRET_APP_KEY",
  "CODING_MAX_CONCURRENT",
  "WARDBY_JIRA_SITE_URL",
  "WARDBY_JIRA_API_BASE_URL",
  "WARDBY_JIRA_API_EMAIL",
  "WARDBY_JIRA_API_TOKEN",
  "WARDBY_JIRA_API_TOKEN_EXPIRES_AT",
  "WARDBY_JIRA_WEBHOOK_SECRET",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) if (k.startsWith("WARDBY_JIRA_")) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  notificationsMock.startNotifications.mockClear();
});

const fakeExecutor: Executor = { async start() {}, async stop() {} };
// startMcp only touches providers.executor at startup; the scheduler and
// reconciler only need start/stop. Everything else is unused for this test.
const providers = { executor: fakeExecutor } as McpProviders;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function until(pred: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("startServe transport guard", () => {
  it("refuses stdio, whose stdout is the JSON-RPC wire", async () => {
    process.env.MCP_TRANSPORT = "stdio";
    await expect(startServe({ providers })).rejects.toThrow(/MCP_TRANSPORT=http/);
  });

  it("fails fast on a malformed coding concurrency setting, before MCP starts listening", async () => {
    process.env.MCP_TRANSPORT = "http";
    process.env.CODING_MAX_CONCURRENT = "four";
    await expect(startServe({ providers })).rejects.toThrow(/CODING_MAX_CONCURRENT/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("startServe (database)", () => {
  const db = createPrismaClient();
  const scope = "serve-test-" + randomUUID();
  afterAll(async () => {
    await db.schedulerLease.deleteMany({ where: { scope: { in: [scope, scope + "-chat"] } } });
    await db.$disconnect();
  });

  it("runs MCP, scheduler, and reconciler on one executor and shuts down cleanly", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    Object.assign(process.env, {
      MCP_TRANSPORT: "http",
      MCP_HTTP_BIND: `127.0.0.1:${port}`,
      MCP_CANONICAL_URI: origin,
      AUTH_PROVIDER: "self-hosted",
      AUTH_AUDIENCE: origin,
      AUTH_SIGNING_KEY: "a1".repeat(32),
      AUTH_CREDENTIAL_HASH_KEY: "b2".repeat(32),
      SECRET_APP_KEY: "c3".repeat(32),
    });

    const handle = await startServe({ providers, scope });
    try {
      // Scheduler: acquires the lease for our private scope almost immediately.
      expect(await until(() => handle.isLeader())).toBe(true);
      const lease = await db.schedulerLease.findUnique({ where: { scope } });
      expect(lease).not.toBeNull();
      expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // MCP: the HTTP transport is up and enforcing auth.
      const res = await fetch(origin + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }

    // Shutdown: the port is released.
    await expect(fetch(origin + "/mcp", { method: "POST" })).rejects.toThrow();
  });

  it("passes providers.chat to startNotifications and stops it on close()", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    Object.assign(process.env, {
      MCP_TRANSPORT: "http",
      MCP_HTTP_BIND: `127.0.0.1:${port}`,
      MCP_CANONICAL_URI: origin,
      AUTH_PROVIDER: "self-hosted",
      AUTH_AUDIENCE: origin,
      AUTH_SIGNING_KEY: "a1".repeat(32),
      AUTH_CREDENTIAL_HASH_KEY: "b2".repeat(32),
      SECRET_APP_KEY: "c3".repeat(32),
    });

    const chat = { slack: new FakeChatProvider() };
    const providersWithChat = { ...providers, chat } as McpProviders;
    const chatScope = scope + "-chat";

    const handle = await startServe({ providers: providersWithChat, scope: chatScope });
    try {
      expect(notificationsMock.startNotifications).toHaveBeenCalledWith(
        expect.objectContaining({ chat, db: expect.anything() }),
      );
    } finally {
      await handle.close();
    }

    const notificationsHandle = await notificationsMock.startNotifications.mock.results[0].value;
    expect(notificationsHandle.stop).toHaveBeenCalledTimes(1);
  });
});
