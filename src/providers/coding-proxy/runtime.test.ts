import type { PrismaClient } from "#prisma";
import { describe, expect, it, vi } from "vitest";
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { logger } from "../../core/logger.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import type { CodingProxy, CodingProxyOptions, ProxyResponseSink } from "./proxy.js";
import { DependencyCacheService } from "./dependency-cache/service.js";
import { RegistryService } from "./registry/service.js";
import { createRegistryUpstream, startConfiguredCodingProxy } from "./runtime.js";
import type { CodingProxyServerHandle } from "./server.js";
import type { ProxyAuditEvent } from "./types.js";

// Records the options every CodingProxy is constructed with, so a test can see
// what startConfiguredCodingProxy handed it (the instance keeps them private).
const constructed = vi.hoisted(() => [] as CodingProxyOptions[]);
vi.mock("./proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./proxy.js")>();
  class RecordingCodingProxy extends actual.CodingProxy {
    constructor(options: CodingProxyOptions) {
      super(options);
      constructed.push(options);
    }
  }
  return { ...actual, CodingProxy: RecordingCodingProxy };
});

describe("configured coding proxy runtime", () => {
  it("binds the fixed worker-only endpoint and host header", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));

    const started = await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { OPENAI_API_KEY: "test-secret" },
      startServer,
      startDenyPort,
    });
    expect(started.port).toBe(handle.port);

    expect(startServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        host: "0.0.0.0",
        port: CODING_PROXY_PORT,
        expectedHost: `${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
        registry: expect.any(RegistryService),
      }),
    );
  });

  it("wires the registry service's pinned upstream with the OSV host allowed alongside every adapter's hosts", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    let allowedHosts: string[] = [];
    const createPinnedFetch = vi.fn((options: { allowedHosts: string[] }) => {
      allowedHosts = options.allowedHosts;
      return vi.fn(async () => new Response("{}"));
    });

    await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { OPENAI_API_KEY: "test-secret" },
      startServer,
      startDenyPort,
      createPinnedFetch,
    });

    expect(createPinnedFetch).toHaveBeenCalledTimes(1);
    expect(allowedHosts).toEqual(
      expect.arrayContaining(["api.osv.dev", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]),
    );
  });

  it("starts the deny-port listener alongside the proxy and closes both", async () => {
    const closed: string[] = [];
    const handle: CodingProxyServerHandle = {
      port: CODING_PROXY_PORT,
      close: async () => void closed.push("proxy"),
    };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({
      port: CODING_PROXY_DENY_PORT,
      close: async () => void closed.push("deny"),
    }));

    const started = await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { OPENAI_API_KEY: "test-secret" },
      startServer,
      startDenyPort,
    });

    expect(startDenyPort).toHaveBeenCalledWith("0.0.0.0", CODING_PROXY_DENY_PORT);
    expect(started.port).toBe(CODING_PROXY_PORT);
    await started.close();
    expect(closed).toEqual(["deny", "proxy"]);
  });

  it("wires the dependency cache only when it is on and a blob store is configured", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    const cacheOf = async (env: NodeJS.ProcessEnv) => {
      const startServer = vi.fn(async () => handle);
      const started = await startConfiguredCodingProxy({ db: {} as PrismaClient, env, startServer, startDenyPort });
      await started.close();
      const [proxy, config] = startServer.mock.calls[0] as unknown[];
      return {
        ...(config as { dependencyCache?: unknown }),
        sealsOnModelRequest: (proxy as { onModelRequest?: unknown }).onModelRequest !== undefined,
      };
    };
    const base = { OPENAI_API_KEY: "test-secret" };
    const blob = { BLOB_STORE: "local", BLOB_STORE_LOCAL_DIR: "/tmp/wardby-cache-test" };
    const off = await cacheOf(base);
    expect([off.dependencyCache, off.sealsOnModelRequest]).toEqual([undefined, false]);
    expect((await cacheOf({ ...base, ...blob })).dependencyCache).toBeUndefined();
    const warn = vi.spyOn(logger, "warn");
    expect((await cacheOf({ ...base, WARDBY_DEPENDENCY_CACHE: "true" })).dependencyCache).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "proxy.dependency_cache_no_blob_store" }),
      expect.any(String),
    );
    warn.mockRestore();
    const on = await cacheOf({ ...base, ...blob, WARDBY_DEPENDENCY_CACHE: "true" });
    expect(on.dependencyCache).toBeInstanceOf(DependencyCacheService);
    expect(on.sealsOnModelRequest).toBe(true);
    expect((on.dependencyCache as DependencyCacheService).uploadMs).toBe(900_000);
  });

  it("closes the proxy server when the deny port cannot bind", async () => {
    const closed: string[] = [];
    const handle: CodingProxyServerHandle = {
      port: CODING_PROXY_PORT,
      close: async () => void closed.push("proxy"),
    };
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { OPENAI_API_KEY: "test-secret" },
        startServer: async () => handle,
        startDenyPort: async () => {
          throw new Error("EADDRINUSE");
        },
      }),
    ).rejects.toThrow("EADDRINUSE");
    expect(closed).toEqual(["proxy"]);
  });
});

describe("createRegistryUpstream", () => {
  it("maps accept to a header, sends json content-type only when a body is present, and forwards method/signal/redirect", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const pinned = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const upstream = createRegistryUpstream(pinned);
    const signal = new AbortController().signal;

    await upstream("https://api.osv.dev/v1/query", {
      method: "POST",
      accept: "application/json",
      body: '{"package":{"name":"left-pad"}}',
      signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.osv.dev/v1/query");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.signal).toBe(signal);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("omits content-type for a bodyless GET and defaults to method GET", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const pinned = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const upstream = createRegistryUpstream(pinned);

    await upstream("https://registry.npmjs.org/left-pad", { accept: "application/json" });

    expect(calls[0].init.method).toBe("GET");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("content-type")).toBe(false);
    expect(headers.has("accept-encoding")).toBe(false);

    // A caller that decompresses itself (lockfile plans stream packuments) asks for gzip.
    await upstream("https://registry.npmjs.org/left-pad", { accept: "application/json", acceptEncoding: "gzip" });
    expect(new Headers(calls[1].init.headers).get("accept-encoding")).toBe("gzip");
  });
});

describe("configured coding proxy runtime: database pools", () => {
  it("gives the package registry its own client, so registry traffic cannot starve the ledger's pool", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    const db = { name: "ledger" } as unknown as PrismaClient;
    const registryDb = { name: "registry" } as unknown as PrismaClient;

    await startConfiguredCodingProxy({ db, registryDb, env: {}, startServer, startDenyPort });

    const calls = startServer.mock.calls as unknown as [unknown, { registry: RegistryService }][];
    const registry = calls[0][1].registry as unknown as { options: { store: { db: unknown } } };
    expect(registry.options.store.db).toBe(registryDb);
  });
});

describe("configured coding proxy runtime: load-test mock upstream", () => {
  const MOCK_ENV = {
    OPENAI_API_KEY: "test-secret",
    WARDBY_LOAD_TEST: "1",
    WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1",
    WARDBY_LOAD_MOCK_LATENCY_MS: "0",
  };

  async function start(env: NodeJS.ProcessEnv) {
    constructed.length = 0;
    const events: ProxyAuditEvent[] = [];
    let proxy: CodingProxy | undefined;
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async (built: CodingProxy) => {
      proxy = built;
      return handle;
    });
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    const createPinnedFetch = vi.fn(() => vi.fn(async () => new Response("{}")));
    await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env,
      startServer,
      startDenyPort,
      createPinnedFetch,
      audit: (event) => events.push(event),
    });
    expect(constructed).toHaveLength(1);
    // The ledger is built from the Prisma client; swap in the in-memory one so a
    // request can run through the constructed proxy without a database.
    (proxy as unknown as { ledger: MemoryProxyLedger }).ledger = new MemoryProxyLedger();
    return { proxy: proxy!, options: constructed[0], events, createPinnedFetch };
  }

  async function oneRequest(proxy: CodingProxy) {
    const session = await proxy.createSession({
      runId: "run-load-1",
      credentialRef: "env:OPENAI_API_KEY",
      protocol: "openai-responses",
      allowedModels: ["gpt-5.6-luna"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
    });
    const chunks: Buffer[] = [];
    const sink: ProxyResponseSink & { status?: number } = {
      start(status: number) {
        sink.status = status;
      },
      write: (chunk: Uint8Array) => void chunks.push(Buffer.from(chunk)),
      end: () => {},
      destroy: () => {},
    };
    await proxy.execute(
      {
        bearer: session.capability,
        protocol: session.protocol,
        rawBody: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          input: "Task:\nx\n\nThe final JSON runId must be run-load-1.",
        }),
        requestKey: "k1",
      },
      sink,
    );
    return { status: sink.status, text: Buffer.concat(chunks).toString("utf8") };
  }

  it("with both switches set, hands the proxy the mock fetch, warns, and tags every audit event", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    try {
      const { proxy, options, events } = await start(MOCK_ENV);
      expect(options.fetch).toEqual(expect.any(Function));
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "proxy.mock_upstream_enabled" }),
        expect.stringContaining("MOCK MODEL UPSTREAM ENABLED"),
      );

      const { status, text } = await oneRequest(proxy);
      expect(status).toBe(200);
      expect(text).toContain("resp_mock_run-load-1");
      expect(text).toContain("no_changes");
      expect(network).not.toHaveBeenCalled();

      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["session.created", "request.reserved", "response.completed"]),
      );
      for (const event of events) expect(event.mockUpstream).toBe(true);
    } finally {
      warn.mockRestore();
      network.mockRestore();
    }
  });

  it("refuses to start with only the mock switch set", async () => {
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1" },
        startServer: vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} })),
        startDenyPort: vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} })),
      }),
    ).rejects.toThrow(/^mock_upstream_guard:/);
  });

  it("refuses to start with only the load-test switch set, before any listener starts", async () => {
    const startServer = vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} }));
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { WARDBY_LOAD_TEST: "1" },
        startServer,
        startDenyPort: vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} })),
      }),
    ).rejects.toThrow(/^mock_upstream_guard:/);
    expect(startServer).not.toHaveBeenCalled();
  });

  it("with neither switch, passes no fetch, does not warn, and leaves audit events untagged", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { proxy, options, events } = await start({ OPENAI_API_KEY: "test-secret" });
      expect(options).not.toHaveProperty("fetch");
      expect(warn).not.toHaveBeenCalled();
      await proxy.createSession({
        runId: "run-real-1",
        credentialRef: "env:OPENAI_API_KEY",
        protocol: "openai-responses",
        allowedModels: ["gpt-5.6-luna"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
      });
      expect(events).toEqual([expect.objectContaining({ type: "session.created" })]);
      for (const event of events) expect(event).not.toHaveProperty("mockUpstream");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createRegistryUpstream with an upstream credential", () => {
  const credentials = { host: "example.jfrog.io", authorization: "Basic c3ZjOnB3" };
  const capture = () => {
    const seen: { url: string; headers: Headers }[] = [];
    const pinned = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    return { seen, upstream: createRegistryUpstream(pinned, credentials) };
  };

  it("sends the credential to the JFrog host only, never to public registries or OSV", async () => {
    const { seen, upstream } = capture();
    await upstream("https://example.jfrog.io/acme/api/npm/npm-local/@acme%2fui");
    await upstream("https://registry.npmjs.org/left-pad");
    await upstream("https://pypi.org/simple/requests/");
    await upstream("https://api.osv.dev/v1/query", { method: "POST", body: "{}" });
    await upstream("https://example.jfrog.io.evil.test/x");
    expect(seen.map((call) => call.headers.get("authorization"))).toEqual(["Basic c3ZjOnB3", null, null, null, null]);
  });

  it("sends no authorization header without a credential", async () => {
    const seen: Headers[] = [];
    const pinned = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    await createRegistryUpstream(pinned)("https://example.jfrog.io/x");
    expect(seen[0].has("authorization")).toBe(false);
  });
});

describe("createRegistryUpstream redirect following", () => {
  const credentials = { host: "example.jfrog.io", authorization: "Basic c3ZjOnB3" };
  const file = "https://example.jfrog.io/acme/api/pypi/pypi/packages/packages/ab/cd/x-1.0-py3-none-any.whl";
  const redirect = (location: string | null, status = 302) =>
    new Response(null, { status, headers: location ? { location } : {} });

  const setup = (first: Response, second: Response = new Response("wheel")) => {
    const calls: { fetcher: "pinned" | "redirect"; url: string; init?: RequestInit }[] = [];
    const pinned = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ fetcher: "pinned", url, init });
      return first;
    }) as unknown as typeof globalThis.fetch;
    const redirectFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ fetcher: "redirect", url, init });
      return second;
    }) as unknown as typeof globalThis.fetch;
    return { calls, upstream: createRegistryUpstream(pinned, credentials, redirectFetch) };
  };

  it("follows one redirect from JFrog to the target, without the credential", async () => {
    const { calls, upstream } = setup(redirect("https://storage.googleapis.com/bucket/x.whl?X-Goog-Signature=abc"));
    const response = await upstream(file, { accept: "application/octet-stream" });
    expect(await response.text()).toBe("wheel");
    expect(calls.map((call) => call.fetcher)).toEqual(["pinned", "redirect"]);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Basic c3ZjOnB3");
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[1].url).toBe("https://storage.googleapis.com/bucket/x.whl?X-Goog-Signature=abc");
    expect(new Headers(calls[1].init?.headers).has("authorization")).toBe(false);
    expect(new Headers(calls[1].init?.headers).get("accept")).toBe("application/octet-stream");
    expect(calls[1].init?.redirect).toBe("error");
  });

  it("resolves a relative Location against the JFrog URL", async () => {
    const { calls, upstream } = setup(redirect("/other/path/x.whl"));
    await upstream(file);
    expect(calls[1].url).toBe("https://example.jfrog.io/other/path/x.whl");
  });

  it.each([
    ["a plain-http target", "http://storage.googleapis.com/x.whl"],
    ["a target with embedded credentials", "https://user:pw@storage.googleapis.com/x.whl"],
    ["no Location header", null],
  ])("refuses a redirect with %s", async (_label, location) => {
    const { calls, upstream } = setup(redirect(location));
    await expect(upstream(file)).rejects.toThrow("proxy_egress_blocked");
    expect(calls.map((call) => call.fetcher)).toEqual(["pinned"]);
  });

  it("does not follow redirects for other hosts, for non-GET requests, or without a redirect fetch", async () => {
    const other = setup(redirect("https://storage.googleapis.com/x"));
    await other.upstream("https://registry.npmjs.org/left-pad");
    expect(other.calls[0].init?.redirect).toBe("error");

    const post = setup(redirect("https://storage.googleapis.com/x"));
    await post.upstream(file, { method: "POST", body: "{}" });
    expect(post.calls[0].init?.redirect).toBe("error");

    const seen: RequestInit[] = [];
    const pinned = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    await createRegistryUpstream(pinned, credentials)(file);
    expect(seen[0].redirect).toBe("error");
  });

  it("returns a non-redirect response from JFrog untouched", async () => {
    const { calls, upstream } = setup(new Response("index"));
    expect(await (await upstream(file)).text()).toBe("index");
    expect(calls.map((call) => call.fetcher)).toEqual(["pinned"]);
  });
});

describe("configured coding proxy runtime with a JFrog registry", () => {
  const jfrogEnv = {
    OPENAI_API_KEY: "test-secret",
    REGISTRY_JFROG_URL: "https://example.jfrog.io/acme",
    REGISTRY_JFROG_NPM_REPO: "npm-local",
    REGISTRY_JFROG_NPM_SCOPES: "@acme",
    REGISTRY_JFROG_PYPI_REPO: "pypi",
    REGISTRY_UPSTREAM_USERNAME: "env:JFROG_USER",
    REGISTRY_UPSTREAM_PASSWORD: "env:JFROG_PASS",
    JFROG_USER: "svc",
    JFROG_PASS: "s3cret",
  };
  const start = (
    env: Record<string, string>,
    createPinnedFetch: (options: { allowedHosts: string[] }) => typeof globalThis.fetch = () =>
      vi.fn(async () => new Response("{}")),
  ) => {
    const startServer = vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} }));
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    return {
      startServer,
      createPinnedFetch,
      started: startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env,
        startServer,
        startDenyPort,
        createPinnedFetch,
      }),
    };
  };

  it("allows the JFrog host alongside public npm and OSV, and no longer allows the public PyPI hosts", async () => {
    const built: { allowedHosts: string[]; anyPublicHost?: boolean }[] = [];
    const createPinnedFetch = vi.fn((options: { allowedHosts: string[]; anyPublicHost?: boolean }) => {
      built.push(options);
      return vi.fn(async () => new Response("{}"));
    });
    await start(jfrogEnv, createPinnedFetch).started;
    const strict = built.filter((options) => !options.anyPublicHost);
    expect(strict).toHaveLength(1);
    const allowedHosts = strict[0].allowedHosts;
    expect(allowedHosts).toEqual(expect.arrayContaining(["api.osv.dev", "registry.npmjs.org", "example.jfrog.io"]));
    expect(allowedHosts).not.toContain("pypi.org");
    expect(allowedHosts).not.toContain("files.pythonhosted.org");
  });

  it("builds a second, redirect-only fetch for JFrog downloads, never with OSV or the credential's hosts widened", async () => {
    const built: { allowedHosts: string[]; anyPublicHost?: boolean }[] = [];
    const createPinnedFetch = vi.fn((options: { allowedHosts: string[]; anyPublicHost?: boolean }) => {
      built.push(options);
      return vi.fn(async () => new Response("{}"));
    });
    await start(jfrogEnv, createPinnedFetch).started;
    const open = built.filter((options) => options.anyPublicHost);
    expect(open).toHaveLength(1);
    expect(open[0].allowedHosts).not.toContain("api.osv.dev");
  });

  it("builds no redirect fetch without a JFrog registry", async () => {
    const built: { anyPublicHost?: boolean }[] = [];
    const createPinnedFetch = vi.fn((options: { allowedHosts: string[]; anyPublicHost?: boolean }) => {
      built.push(options);
      return vi.fn(async () => new Response("{}"));
    });
    await start({ OPENAI_API_KEY: "test-secret" }, createPinnedFetch).started;
    expect(built.some((options) => options.anyPublicHost)).toBe(false);
  });

  it.each([
    ["an invalid setting", { ...jfrogEnv, REGISTRY_JFROG_URL: "http://example.jfrog.io/acme" }],
    ["a missing credential", { ...jfrogEnv, REGISTRY_UPSTREAM_PASSWORD: undefined }],
    ["a credential reference to an unset variable", { ...jfrogEnv, JFROG_PASS: undefined }],
    [
      "a credential with no repo configured",
      { OPENAI_API_KEY: "x", REGISTRY_UPSTREAM_USERNAME: "env:A", REGISTRY_UPSTREAM_PASSWORD: "env:B" },
    ],
  ])("fails before listening on %s", async (_label, env) => {
    const { started, startServer } = start(env as Record<string, string>);
    await expect(started).rejects.toThrow(/registry_jfrog_config_invalid/);
    expect(startServer).not.toHaveBeenCalled();
  });
});
