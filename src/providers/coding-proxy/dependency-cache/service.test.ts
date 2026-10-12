import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "../../storage/local.js";
import { MemoryProxyLedger } from "../memory-ledger.js";
import { CodingProxy, capabilityHash } from "../proxy.js";
import { MemoryRegistryStore, type RegistryRunContext } from "../registry/store.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "../server.js";
import { computePolicyHash, deriveSnapshotKey } from "./key.js";
import { DependencyCacheService } from "./service.js";
import { MemoryDependencyCacheStore } from "./store.js";

const TOKEN = "rrg_cache_token";
const OTHER_TOKEN = "rrg_other_token";
const hex = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const LOCK = hex("lockfile one");
const LOCK_TWO = hex("lockfile two");
const IMAGE = "ghcr.io/wardby/worker@sha256:1111";
const ALLOWLIST = { npm: ["react"] };
const POLICY = { minReleaseAgeDays: 3 };

function fakeProxy(): CodingProxy {
  return new CodingProxy({ ledger: new MemoryProxyLedger(), credentials: { resolve: async () => "UNUSED" } });
}

function context(overrides: Partial<RegistryRunContext> = {}): RegistryRunContext {
  return {
    runId: "run-1",
    deadlineAt: new Date(Date.now() + 3_600_000),
    allowlist: ALLOWLIST,
    policy: POLICY,
    repository: "owner/repo",
    cacheImage: IMAGE,
    dependencyCache: true,
    ...overrides,
  };
}

const servers: CodingProxyServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(
  options: {
    configured?: boolean;
    run?: Partial<RegistryRunContext>;
    maxSnapshotBytes?: number;
    uploadMs?: number;
    now?: () => Date;
    lockHashes?: string[];
    requestMs?: number;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "dep-cache-"));
  dirs.push(dir);
  const blobs = new LocalBlobStore(dir);
  const registry = new MemoryRegistryStore();
  registry.contexts.set(capabilityHash(TOKEN), context(options.run));
  registry.contexts.set(
    capabilityHash(OTHER_TOKEN),
    context({ runId: "run-2", repository: "other/repo", ...options.run }),
  );
  for (const runId of ["run-1", "run-2"])
    registry.cacheSessions.set(runId, {
      lockHashes: [...(options.lockHashes ?? [LOCK])],
      sealedAt: null,
      createdAt: new Date(),
    });
  const store = new MemoryDependencyCacheStore(registry.cacheSessions);
  const cache = new DependencyCacheService({
    registry,
    store,
    blobs,
    maxSnapshotBytes: options.maxSnapshotBytes ?? 1024 * 1024,
    uploadMs: options.uploadMs ?? 900_000,
    now: options.now,
  });
  const server = await startCodingProxyServer(fakeProxy(), {
    host: "127.0.0.1",
    port: 0,
    requestMs: options.requestMs,
    ...(options.configured === false ? {} : { dependencyCache: cache }),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
  const query = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, value);
    const text = search.toString();
    return text ? `?${text}` : "";
  };
  const json = async (response: Response) => ({ status: response.status, body: await response.json() });
  return {
    dir,
    blobs,
    store,
    registry,
    base,
    lookup: (params: Record<string, string | undefined> = { lock: LOCK }, token?: string) =>
      fetch(`${base}/cache/npm/lookup${query(params)}`, { headers: auth(token) }).then(json),
    upload: (body: Uint8Array, params: Record<string, string | undefined> = { lock: LOCK }, token?: string) =>
      fetch(`${base}/cache/npm/blob${query(params)}`, { method: "PUT", headers: auth(token), body }).then(json),
    download: (id: string, params: Record<string, string | undefined> = { lock: LOCK }, token?: string) =>
      fetch(`${base}/cache/npm/blob/${id}${query(params)}`, { headers: auth(token) }),
    seal: (token?: string) => fetch(`${base}/cache/npm/seal`, { method: "POST", headers: auth(token) }).then(json),
    derived: (projectPath = ".", lockHash = LOCK, repository = "owner/repo") =>
      deriveSnapshotKey({
        repository,
        projectPath,
        lockHash,
        workerImage: IMAGE,
        policyHash: computePolicyHash(ALLOWLIST, POLICY),
      }),
  };
}

const archive = new TextEncoder().encode("gzip tar bytes of node_modules");

describe("dependency cache routes: switches and authentication", () => {
  it("answers 404 for every route when the cache is not configured", async () => {
    const { base } = await setup({ configured: false });
    for (const [method, path] of [
      ["GET", "/cache/npm/lookup"],
      ["PUT", "/cache/npm/blob"],
      ["GET", "/cache/npm/blob/x"],
      ["POST", "/cache/npm/seal"],
    ]) {
      const response = await fetch(`${base}${path}?lock=${LOCK}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(404);
    }
  });

  it("answers 404 for a run whose agent has the cache off, or with no recorded image", async () => {
    for (const run of [{ dependencyCache: false }, { cacheImage: null }]) {
      const { lookup, seal } = await setup({ run });
      expect(await lookup()).toEqual({ status: 404, body: { error: "not_found" } });
      expect((await seal()).status).toBe(404);
    }
  });

  it("refuses an unknown registry token, an unknown route and a wrong method", async () => {
    const { lookup, base } = await setup();
    expect(await lookup({ lock: LOCK }, "rrg_nope")).toEqual({ status: 401, body: { error: "invalid_capability" } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${base}/cache/npm/other`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/cache/pypi/lookup?lock=${LOCK}`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/cache/npm/lookup?lock=${LOCK}`, { method: "DELETE", headers: auth })).status).toBe(
      405,
    );
  });
});

describe("dependency cache lookup", () => {
  it("requires a lockfile the run's plan approved", async () => {
    const { lookup } = await setup();
    expect(await lookup({ lock: LOCK_TWO })).toEqual({ status: 409, body: { error: "plan_required" } });
    expect(await lookup({})).toEqual({ status: 409, body: { error: "plan_required" } });
    expect(await lookup({ lock: "../../etc" })).toEqual({ status: 409, body: { error: "plan_required" } });
  });

  it("refuses an invalid project path", async () => {
    const { lookup, upload } = await setup();
    for (const project of ["../x", "a/node_modules", ".git", "a/b/c/d", "/abs"]) {
      expect(await lookup({ lock: LOCK, project })).toEqual({ status: 400, body: { error: "invalid_project" } });
      expect(await upload(archive, { lock: LOCK, project })).toEqual({
        status: 400,
        body: { error: "invalid_project" },
      });
    }
  });

  it("derives the key on the proxy, ignoring anything else the client sends", async () => {
    const { lookup, derived } = await setup();
    const { status, body } = await lookup({
      lock: LOCK,
      repository: "evil/repo",
      image: "evil:latest",
      policy: "{}",
      key: "dependency-cache/npm/x",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ key: derived().keyId, hit: false, maxBytes: 1024 * 1024 });
  });

  it("refuses a repeated query parameter", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/cache/npm/lookup?lock=${LOCK}&lock=${LOCK_TWO}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(400);
  });
});

describe("dependency cache upload and download", () => {
  it("stores the upload under the derived key with its sha256, then serves it", async () => {
    const { upload, lookup, download, store, blobs, derived } = await setup();
    expect(await upload(archive)).toEqual({
      status: 201,
      body: { stored: true, sha256: hex(archive), sizeBytes: archive.byteLength },
    });
    const key = derived();
    expect(store.rows).toEqual([
      expect.objectContaining({
        ecosystem: "npm",
        repository: "owner/repo",
        projectPath: ".",
        lockHash: LOCK,
        workerImage: IMAGE,
        policyHash: computePolicyHash(ALLOWLIST, POLICY),
        blobKey: key.blobKey,
        sha256: hex(archive),
        sizeBytes: archive.byteLength,
        createdByRunId: "run-1",
      }),
    ]);
    expect(await blobs.head(key.blobKey)).toMatchObject({ sizeBytes: archive.byteLength });

    expect((await lookup()).body).toEqual({ key: key.keyId, hit: true, maxBytes: 1024 * 1024 });
    const before = store.rows[0].lastUsedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await download(key.keyId);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wardby-sha256")).toBe(hex(archive));
    expect(response.headers.get("content-length")).toBe(String(archive.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(archive);
    expect(store.rows[0].lastUsedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("accepts one upload per project per run; another project is allowed", async () => {
    const { upload } = await setup();
    expect((await upload(archive)).status).toBe(201);
    expect(await upload(new TextEncoder().encode("different"))).toEqual({
      status: 409,
      body: { error: "already_uploaded" },
    });
    expect((await upload(archive, { lock: LOCK, project: "packages/web" })).status).toBe(201);
  });

  it("answers an upload for a key already stored as success without storing it again", async () => {
    const { upload, store } = await setup();
    // Same repository, lock, image and policy in another run: the same key.
    expect((await upload(archive)).status).toBe(201);
    const otherSameRepo = await setup();
    otherSameRepo.store.rows.push(...store.rows.map((row) => ({ ...row, createdByRunId: "run-earlier" })));
    expect(await otherSameRepo.upload(archive)).toEqual({ status: 200, body: { stored: false, reason: "exists" } });
    expect(otherSameRepo.store.rows).toHaveLength(1);
  });

  it("enforces maxBytes, from content-length and while streaming", async () => {
    const { upload, store, dir, base } = await setup({ maxSnapshotBytes: 16 });
    expect(await upload(new Uint8Array(17))).toEqual({ status: 413, body: { error: "too_large" } });
    // Chunked (no content-length): refused while streaming.
    const status = await new Promise<number | "reset">((resolve) => {
      const request = httpRequest(
        `${base}/cache/npm/blob?lock=${LOCK}`,
        { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "transfer-encoding": "chunked" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", () => resolve("reset"));
      request.write(new Uint8Array(10));
      request.write(new Uint8Array(10));
      request.end();
    });
    expect([413, "reset"]).toContain(status);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.rows).toEqual([]);
    expect(
      await readdir(dir, { recursive: true, withFileTypes: true }).then((e) => e.filter((x) => x.isFile())),
    ).toEqual([]);
  });

  it("refuses an upload past the upload window", async () => {
    let now = new Date();
    const { upload, store } = await setup({ uploadMs: 60_000, now: () => now });
    now = new Date(now.getTime() + 61_000);
    expect(await upload(archive)).toEqual({ status: 409, body: { error: "upload_expired" } });
    expect(store.rows).toEqual([]);
  });

  it("refuses a download of another repository's key or of an unrelated id", async () => {
    const { upload, download, derived, store } = await setup();
    expect((await upload(archive, { lock: LOCK }, OTHER_TOKEN)).status).toBe(201);
    const otherKey = derived(".", LOCK, "other/repo");
    expect((await download(otherKey.keyId)).status).toBe(404);
    expect((await download(store.rows[0].id)).status).toBe(404);
    expect((await download("cunrelated000000000000000")).status).toBe(404);
    expect((await download("..%2F..%2Fsecret")).status).toBe(404);
    // Its owner can.
    expect((await download(otherKey.keyId, { lock: LOCK }, OTHER_TOKEN)).status).toBe(200);
  });

  it("offers and serves the nearest snapshot of the same project for a different lockfile", async () => {
    const { upload, lookup, download, store } = await setup({ lockHashes: [LOCK, LOCK_TWO] });
    expect((await upload(archive, { lock: LOCK_TWO })).status).toBe(201);
    expect((await upload(archive, { lock: LOCK_TWO, project: "web" })).status).toBe(201);
    const nearest = store.rows.find((row) => row.projectPath === ".")!;
    const elsewhere = store.rows.find((row) => row.projectPath === "web")!;
    const { body } = await lookup({ lock: LOCK });
    expect(body).toMatchObject({ hit: false, nearest: { id: nearest.id } });
    const response = await download(nearest.id, { lock: LOCK });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wardby-sha256")).toBe(hex(archive));
    await response.arrayBuffer();
    // Another project's snapshot is never the nearest.
    expect((await download(elsewhere.id, { lock: LOCK })).status).toBe(404);
  });

  it("drops a row whose blob is gone", async () => {
    const { upload, download, derived, store, blobs } = await setup();
    await upload(archive);
    await blobs.delete(derived().blobKey);
    expect((await download(derived().keyId)).status).toBe(404);
    expect(store.rows).toEqual([]);
  });
});

describe("dependency cache seal", () => {
  it("is idempotent and closes every other route", async () => {
    const { seal, lookup, upload, download, store, registry, derived } = await setup();
    expect((await upload(archive, { lock: LOCK, project: "web" })).status).toBe(201);
    expect(await seal()).toEqual({ status: 200, body: { sealed: true } });
    const sealedAt = registry.cacheSessions.get("run-1")!.sealedAt;
    expect(sealedAt).toBeInstanceOf(Date);
    expect(await seal()).toEqual({ status: 200, body: { sealed: true } });
    expect(registry.cacheSessions.get("run-1")!.sealedAt).toBe(sealedAt);

    expect(await upload(archive)).toEqual({ status: 409, body: { error: "sealed" } });
    expect(await lookup()).toEqual({ status: 409, body: { error: "sealed" } });
    const response = await download(derived("web").keyId, { lock: LOCK, project: "web" });
    expect([response.status, await response.json()]).toEqual([409, { error: "sealed" }]);
    expect(store.rows).toHaveLength(1);
  });

  it("refuses an upload that finishes after the seal, and keeps nothing of it", async () => {
    const { base, seal, store, dir } = await setup();
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        `${base}/cache/npm/blob?lock=${LOCK}`,
        { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "transfer-encoding": "chunked" } },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on("error", reject);
      request.write("first half ");
      setTimeout(() => {
        void seal().then(() => request.end("second half"));
      }, 50);
    });
    expect(await result).toEqual({ status: 409, body: JSON.stringify({ error: "sealed" }) });
    expect(store.rows).toEqual([]);
    expect(
      await readdir(dir, { recursive: true, withFileTypes: true }).then((e) => e.filter((x) => x.isFile())),
    ).toEqual([]);
  });
});

describe("request time limits with the cache on", () => {
  it("lets an upload stream for longer than requestMs, but no other request body", async () => {
    const { base, store } = await setup({ requestMs: 150 });
    const slowUpload = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${base}/cache/npm/blob?lock=${LOCK}`,
        { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "transfer-encoding": "chunked" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.write("part one ");
      setTimeout(() => request.write("part two "), 150);
      setTimeout(() => request.end("part three"), 300);
    });
    expect(slowUpload).toBe(201);
    expect(store.rows).toHaveLength(1);

    const stalled = await new Promise<string>((resolve) => {
      const request = httpRequest(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "100" },
      });
      request.on("error", () => resolve("closed"));
      request.on("response", (response) => resolve(`status ${response.statusCode}`));
      request.write("{");
      setTimeout(() => resolve("still open"), 3_000);
    });
    expect(stalled).toBe("closed");
  });
});
