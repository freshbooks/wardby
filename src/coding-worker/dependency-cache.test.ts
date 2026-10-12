import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkConsistency,
  DEFAULT_TIMEOUTS,
  prepareDependencies,
  prepareProject,
  scanArchive,
  verifyTree,
  type DependencyCacheEvent,
  type PrepareResult,
} from "./dependency-cache.mjs";

// ---------------------------------------------------------------- fixtures

const LOCKFILE = {
  name: "demo",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "demo", version: "1.0.0", dependencies: { alpha: "^1.0.0", beta: "^2.0.0" } },
    "node_modules/alpha": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
      integrity: "sha512-alpha100",
    },
    "node_modules/beta": {
      version: "2.0.0",
      resolved: "https://registry.npmjs.org/beta/-/beta-2.0.0.tgz",
      integrity: "sha512-beta200",
      bin: { beta: "bin.js" },
    },
    "node_modules/beta/node_modules/a-very-long-nested-package-name-that-pushes-the-path-beyond-one-hundred-bytes": {
      version: "3.1.4",
      integrity: "sha512-long314",
    },
    "node_modules/fsevents-like": {
      version: "1.0.0",
      integrity: "sha512-optional",
      optional: true,
      os: ["no-such-os"],
    },
  },
};

const LOCKFILE_V2 = {
  ...LOCKFILE,
  packages: {
    ...LOCKFILE.packages,
    "node_modules/alpha": {
      ...LOCKFILE.packages["node_modules/alpha"],
      version: "1.1.0",
      integrity: "sha512-alpha110",
    },
  },
};

/** The fake npm: writes the lockfile's (non-optional) packages, a
 *  package.json for each, a .bin symlink and npm's hidden lockfile, the way
 *  a real install would. FAKE_NPM_MODE: hang | fail | drift. Records argv. */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = process.env.FAKE_NPM_MODE || "";
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") process.exit(1);
else {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  if (process.argv[2] === "ci") fs.rmSync("node_modules", { recursive: true, force: true });
  const hidden = { name: lock.name, version: lock.version, lockfileVersion: lock.lockfileVersion, requires: true, packages: {} };
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || entry.optional) continue;
    const version = mode === "drift" && key === "node_modules/alpha" ? "9.9.9" : entry.version;
    fs.mkdirSync(key, { recursive: true });
    fs.writeFileSync(path.join(key, "package.json"), JSON.stringify({ name: key.split("node_modules/").pop(), version }));
    fs.writeFileSync(path.join(key, "index.js"), "module.exports = " + JSON.stringify(key) + ";\\n");
    hidden.packages[key] = { ...entry, version, resolved: "http://proxy/registry/npm/" + key };
  }
  fs.mkdirSync("node_modules/.bin", { recursive: true });
  try { fs.symlinkSync("../beta/index.js", "node_modules/.bin/beta"); } catch {}
  fs.writeFileSync("node_modules/.package-lock.json", JSON.stringify(hidden, null, 2));
  if (mode === "rewrite-lock") fs.writeFileSync("package-lock.json", "{}");
}
`;

// ---------------------------------------------------------------- fake proxy

interface ProxyState {
  plans: string[];
  calls: string[];
  authorizations: (string | undefined)[];
  planAnswer: { status: number; body: unknown };
  lookupAnswer: (lock: string) => { status: number; body: unknown };
  blobs: Map<string, Buffer>;
  shaOverride?: string;
  lengthOverride?: number;
  uploads: { body: Buffer; contentLength: string | undefined }[];
  sealed: boolean;
  hang?: string;
  seals: number;
}

let root: string;
let workspace: string;
let server: Server;
let base: string;
let state: ProxyState;
let env: Record<string, string>;
let npmLog: string;
let events: DependencyCacheEvent[];

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function startProxy(): Promise<void> {
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://proxy");
      const route = `${request.method} ${url.pathname}`;
      state.calls.push(route);
      state.authorizations.push(request.headers.authorization);
      const json = (status: number, body: unknown) =>
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (state.hang && route.startsWith(state.hang)) return; // never answers
      if (route === "POST /registry/npm/-/plan") {
        state.plans.push((await readBody(request)).toString("utf8"));
        json(state.planAnswer.status, state.planAnswer.body);
        return;
      }
      if (route === "POST /cache/npm/seal") {
        state.sealed = true;
        state.seals += 1;
        json(200, { sealed: true });
        return;
      }
      if (state.sealed) {
        await readBody(request);
        json(409, { error: "sealed" });
        return;
      }
      const lock = url.searchParams.get("lock") ?? "";
      if (url.searchParams.get("project") !== "." || !state.plans.some((plan) => sha256(plan) === lock)) {
        json(409, { error: "plan_required" });
        return;
      }
      if (route === "GET /cache/npm/lookup") {
        const answer = state.lookupAnswer(lock);
        json(answer.status, answer.body);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/cache/npm/blob/")) {
        const blob = state.blobs.get(url.pathname.slice("/cache/npm/blob/".length));
        if (!blob) return json(404, { error: "not_found" });
        response.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": String(state.lengthOverride ?? blob.length),
          "x-wardby-sha256": state.shaOverride ?? sha256(blob),
        });
        response.end(state.lengthOverride && state.lengthOverride < blob.length ? undefined : blob);
        if (state.lengthOverride && state.lengthOverride > blob.length) response.destroy();
        return;
      }
      if (route === "PUT /cache/npm/blob") {
        const body = await readBody(request);
        state.uploads.push({ body, contentLength: request.headers["content-length"] });
        json(201, { stored: true, sha256: sha256(body), sizeBytes: body.length });
        return;
      }
      json(404, { error: "not_found" });
    })();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wardby-depcache-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  state = {
    plans: [],
    calls: [],
    authorizations: [],
    planAnswer: { status: 200, body: { approved: 3, refused: [] } },
    lookupAnswer: () => ({ status: 200, body: { key: "k".repeat(64), hit: false, maxBytes: 64 * 1024 * 1024 } }),
    blobs: new Map(),
    uploads: [],
    sealed: false,
    seals: 0,
  };
  await startProxy();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  const registry = `${base}/registry/npm/`;
  const npmrc = join(root, "npmrc");
  await writeFile(npmrc, `//127.0.0.1:${port}/registry/npm/:_authToken=run-token\n`);
  const npmPath = join(root, "fake-npm");
  await writeFile(npmPath, FAKE_NPM);
  await chmod(npmPath, 0o755);
  npmLog = join(root, "npm.log");
  await writeFile(npmLog, "");
  env = {
    PATH: process.env.PATH ?? "",
    npm_config_registry: registry,
    npm_config_userconfig: npmrc,
    WARDBY_NPM_PLAN_REGISTRY: registry,
    FAKE_NPM_LOG: npmLog,
  };
  events = [];
  await writeRepo(LOCKFILE);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function writeRepo(lockfile: object, packageJson: object = { name: "demo", version: "1.0.0" }) {
  await writeFile(join(workspace, "package.json"), JSON.stringify(packageJson));
  await writeFile(join(workspace, "package-lock.json"), JSON.stringify(lockfile, null, 2));
}

function prepare(options: Partial<Parameters<typeof prepareDependencies>[0]> = {}): Promise<PrepareResult> {
  return prepareDependencies({
    workspace,
    env,
    npmPath: join(root, "fake-npm"),
    log: (event, fields) => events.push({ event, ...fields }),
    ...options,
  });
}

async function npmCalls(): Promise<string[][]> {
  return (await readFile(npmLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Builds a node_modules tree for `lockfile` the way the fake npm does, in
 *  `dir`, and archives it with the system tar. */
async function realTarSnapshot(lockfile: typeof LOCKFILE, extra?: (dir: string) => Promise<void>): Promise<Buffer> {
  const dir = await mkdtemp(join(root, "snap-"));
  await writeFile(join(dir, "package-lock.json"), JSON.stringify(lockfile));
  const install = spawnSync(join(root, "fake-npm"), ["ci"], {
    cwd: dir,
    env: { ...env, FAKE_NPM_MODE: "", FAKE_NPM_LOG: join(dir, "npm.log") },
  });
  expect(install.status).toBe(0);
  if (extra) await extra(dir);
  const archive = join(dir, "out.tgz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", dir, "node_modules"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(tar.status).toBe(0);
  return readFile(archive);
}

// A minimal ustar writer, for archives no well-behaved tar would produce.
interface RawEntry {
  name: string;
  type?: string;
  body?: string;
  size?: number;
  link?: string;
}
function header(name: string, type: string, size: number, link = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(size.toString(8).padStart(11, "0") + "\0", 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write(link, 157, 100, "utf8");
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return block;
}
function rawTar(entries: RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const size = entry.size ?? body.length;
    parts.push(header(entry.name, entry.type ?? "0", size, entry.link));
    if (entry.size === undefined && body.length) {
      parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function hitWith(blob: Buffer, id = "a".repeat(64)) {
  state.blobs.set(id, blob);
  state.lookupAnswer = () => ({ status: 200, body: { key: id, hit: true, maxBytes: 64 * 1024 * 1024 } });
}

async function cacheLeftovers(): Promise<string[]> {
  return (await exists(join(workspace, ".cache"))) ? readdir(join(workspace, ".cache")) : [];
}

// ---------------------------------------------------------------- paths

describe("prepareDependencies", () => {
  it("hit: verifies, scans, extracts, checks consistency and installs nothing", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    const result = await prepare();
    expect(result).toMatchObject({ result: "hit", key: "a".repeat(64) });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(typeof result.restoreMs).toBe("number");
    expect(await npmCalls()).toEqual([]);
    const pkg = JSON.parse(await readFile(join(workspace, "node_modules/alpha/package.json"), "utf8"));
    expect(pkg.version).toBe("1.0.0");
    expect(await readlink(join(workspace, "node_modules/.bin/beta"))).toBe("../beta/index.js");
    // The plan got the exact lockfile bytes; every cache route the same hash.
    const lockBytes = await readFile(join(workspace, "package-lock.json"));
    expect(state.plans).toEqual([lockBytes.toString("utf8")]);
    expect(state.authorizations.every((value) => value === "Bearer run-token")).toBe(true);
    expect(state.calls).toEqual([
      "POST /registry/npm/-/plan",
      "GET /cache/npm/lookup",
      `GET /cache/npm/blob/${"a".repeat(64)}`,
      "POST /cache/npm/seal",
    ]);
    expect(await cacheLeftovers()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("run-token");
  });

  it("cold: npm ci through the shim, consistency, snapshot uploaded with content-length, then seal", async () => {
    const result = await prepare();
    expect(result).toMatchObject({ result: "cold" });
    expect(typeof result.installMs).toBe("number");
    expect(await npmCalls()).toEqual([["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0].contentLength).toBe(String(state.uploads[0].body.length));
    expect(result.sizeBytes).toBe(state.uploads[0].body.length);
    expect(state.calls.slice(-2)).toEqual(["PUT /cache/npm/blob", "POST /cache/npm/seal"]);
    expect(await exists(join(workspace, "node_modules/alpha/package.json"))).toBe(true);
    expect(await cacheLeftovers()).toEqual([]);

    // The uploaded snapshot (real tar, long nested path) restores as a hit.
    await rm(join(workspace, "node_modules"), { recursive: true });
    await writeFile(npmLog, "");
    state.sealed = false;
    hitWith(state.uploads[0].body);
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect(await npmCalls()).toEqual([]);
  });

  it("nearest: restores the nearest snapshot, installs the delta without saving, snapshots", async () => {
    const nearest = await realTarSnapshot(LOCKFILE);
    await writeRepo(LOCKFILE_V2);
    state.blobs.set("b".repeat(64), nearest);
    state.lookupAnswer = () => ({
      status: 200,
      body: { key: "c".repeat(64), hit: false, nearest: { id: "b".repeat(64) }, maxBytes: 64 * 1024 * 1024 },
    });
    const result = await prepare();
    expect(result).toMatchObject({ result: "nearest", key: "c".repeat(64) });
    expect(typeof result.restoreMs).toBe("number");
    expect(typeof result.installMs).toBe("number");
    expect(await npmCalls()).toEqual([["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    const pkg = JSON.parse(await readFile(join(workspace, "node_modules/alpha/package.json"), "utf8"));
    expect(pkg.version).toBe("1.1.0");
    expect(state.uploads).toHaveLength(1);
    expect(state.calls.at(-1)).toBe("POST /cache/npm/seal");
  });

  it("nearest: puts back a lockfile the install rewrote", async () => {
    state.blobs.set("b".repeat(64), await realTarSnapshot(LOCKFILE));
    const committed = await readFile(join(workspace, "package-lock.json"));
    state.lookupAnswer = () => ({
      status: 200,
      body: { key: "c".repeat(64), hit: false, nearest: { id: "b".repeat(64) }, maxBytes: 64 * 1024 * 1024 },
    });
    env.FAKE_NPM_MODE = "rewrite-lock";
    const result = await prepare();
    expect(await readFile(join(workspace, "package-lock.json"))).toEqual(committed);
    expect(result).toMatchObject({ result: "nearest" });
  });

  it("refused: the plan refused a package; no lookup, no install, still sealed", async () => {
    state.planAnswer = {
      status: 200,
      body: { approved: 2, refused: [{ name: "beta", version: "2.0.0", code: "too_new", reason: "x" }] },
    };
    const result = await prepare();
    expect(result).toEqual({ result: "refused", reason: "plan_refused" });
    expect(state.calls).toEqual(["POST /registry/npm/-/plan", "POST /cache/npm/seal"]);
    expect(await npmCalls()).toEqual([]);
  });

  it.each([
    ["no_lockfile", async () => rm(join(workspace, "package-lock.json"))],
    ["lockfile_version", async () => writeRepo({ ...LOCKFILE, lockfileVersion: 1 })],
    ["workspaces", async () => writeRepo(LOCKFILE, { name: "demo", workspaces: ["packages/*"] })],
    ["shrinkwrap_present", async () => writeFile(join(workspace, "npm-shrinkwrap.json"), "{}")],
    ["node_modules_present", async () => mkdir(join(workspace, "node_modules"))],
    ["no_dependencies", async () => writeRepo({ ...LOCKFILE, packages: { "": {} } })],
  ])("skipped: %s, without planning, and still sealed", async (reason, setup) => {
    await setup();
    expect(await prepare()).toEqual({ result: "skipped", reason });
    expect(state.calls).toEqual(["POST /cache/npm/seal"]);
  });

  it("skipped: the plan failed", async () => {
    state.planAnswer = { status: 503, body: { error: "busy" } };
    expect(await prepare()).toEqual({ result: "skipped", reason: "plan_failed" });
    expect(state.calls.at(-1)).toBe("POST /cache/npm/seal");
  });

  it("skipped: the cache is off on the proxy (404)", async () => {
    state.lookupAnswer = () => ({ status: 404, body: { error: "not_found" } });
    expect(await prepare()).toEqual({ result: "skipped", reason: "cache_unavailable" });
    expect(await npmCalls()).toEqual([]);
  });

  it("skipped: no registry configuration means no plan and nothing to seal", async () => {
    delete env.WARDBY_NPM_PLAN_REGISTRY;
    expect(await prepare()).toEqual({ result: "skipped", reason: "no_registry" });
    expect(state.calls).toEqual([]);
  });

  it("skipped: the cold install failed; partial node_modules removed", async () => {
    env.FAKE_NPM_MODE = "fail";
    expect(await prepare()).toEqual({ result: "skipped", reason: "install_failed" });
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(state.uploads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- integrity and safety

const MALICIOUS: [string, RawEntry[], string][] = [
  ["path traversal", [{ name: "node_modules/../../etc/evil", body: "x" }], "unsafe_archive"],
  ["absolute path", [{ name: "/tmp/evil", body: "x" }], "unsafe_archive"],
  ["outside node_modules", [{ name: "src/index.js", body: "x" }], "unsafe_archive"],
  ["escaping symlink", [{ name: "node_modules/x", type: "2", link: "../../outside" }], "unsafe_archive"],
  ["absolute symlink", [{ name: "node_modules/x", type: "2", link: "/etc/passwd" }], "unsafe_archive"],
  ["hardlink", [{ name: "node_modules/x", type: "1", link: "node_modules/y" }], "unsafe_archive"],
  ["char device", [{ name: "node_modules/x", type: "3" }], "unsafe_archive"],
  ["fifo", [{ name: "node_modules/x", type: "6" }], "unsafe_archive"],
  [
    "entry beneath a symlink",
    [
      { name: "node_modules/a", type: "2", link: "b" },
      { name: "node_modules/a/x", body: "x" },
    ],
    "unsafe_archive",
  ],
  [
    "duplicate entry",
    [
      { name: "node_modules/a", body: "x" },
      { name: "node_modules/a", type: "2", link: "b" },
    ],
    "unsafe_archive",
  ],
  ["size bomb", [{ name: "node_modules/big", size: 7 * 1024 * 1024 * 1024 }], "over_budget"],
  [
    "a link chain that escapes only through a linked folder",
    [
      { name: "node_modules/p/", type: "5" },
      { name: "node_modules/p/q", type: "2", link: ".." },
      { name: "node_modules/p/q/r", type: "2", link: "../.." },
    ],
    "unsafe_archive",
  ],
  [
    "a link whose target climbs back out after following another link",
    [
      { name: "node_modules/a/b/s", type: "2", link: "../.." },
      { name: "node_modules/t", type: "2", link: "a/b/s/../.." },
      { name: "node_modules/u", type: "2", link: "t/etc" },
    ],
    "unsafe_archive",
  ],
];
describe("untrusted archives", () => {
  it("rejects a sha256 mismatch and deletes the download", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    state.shaOverride = "0".repeat(64);
    expect(await prepare()).toEqual({ result: "skipped", reason: "sha_mismatch" });
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("rejects a short download (content-length not met)", async () => {
    const blob = await realTarSnapshot(LOCKFILE);
    hitWith(blob);
    state.lengthOverride = blob.length + 100;
    const result = await prepare();
    expect(result.result).toBe("skipped");
    expect(["download_failed", "size_mismatch"]).toContain(result.reason);
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("rejects a download larger than the lookup's maxBytes", async () => {
    const blob = await realTarSnapshot(LOCKFILE);
    state.blobs.set("a".repeat(64), blob);
    state.lookupAnswer = () => ({ status: 200, body: { key: "a".repeat(64), hit: true, maxBytes: 10 } });
    expect(await prepare()).toEqual({ result: "skipped", reason: "too_large" });
  });

  it.each(MALICIOUS)("rejects %s before extracting anything", async (_label, entries, reason) => {
    hitWith(rawTar([{ name: "node_modules/", type: "5" }, ...entries]));
    expect(await prepare({ budgetBytes: 1024 * 1024 * 1024 })).toEqual({ result: "skipped", reason });
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(await exists(join(root, "outside"))).toBe(false);
    expect(await cacheLeftovers()).toEqual([]);
    expect(await npmCalls()).toEqual([]);
  });

  it.each(MALICIOUS)("scanArchive alone rejects %s", async (_label, entries, reason) => {
    const archive = join(root, "bad.tgz");
    await writeFile(archive, rawTar([{ name: "node_modules/", type: "5" }, ...entries]));
    await expect(scanArchive(archive, { budgetBytes: 1024 * 1024 * 1024 })).rejects.toMatchObject({ reason });
  });

  it("verifyTree rejects a written tree with a link out of node_modules, even through a linked folder", async () => {
    const tree = join(root, "tree");
    await mkdir(join(tree, "node_modules/p"), { recursive: true });
    await symlink("..", join(tree, "node_modules/p/q"));
    await expect(verifyTree(tree)).resolves.toBeUndefined();
    await symlink("../..", join(tree, "node_modules/r")); // what p/q/r -> ../.. really is
    await expect(verifyTree(tree)).rejects.toMatchObject({ reason: "unsafe_archive" });
    await rm(join(tree, "node_modules/r"));
    await symlink("/etc", join(tree, "node_modules/abs"));
    await expect(verifyTree(tree)).rejects.toMatchObject({ reason: "unsafe_archive" });
  });

  it("verifyTree rejects a written link that escapes once the kernel follows the links before it", async () => {
    const tree = join(root, "tree");
    await mkdir(join(tree, "node_modules/a/b"), { recursive: true });
    await symlink("../..", join(tree, "node_modules/a/b/s")); // -> node_modules: inside
    await expect(verifyTree(tree)).resolves.toBeUndefined();
    await symlink("a/b/s/../..", join(tree, "node_modules/t")); // lexically node_modules/a; really tree's parent
    await expect(verifyTree(tree)).rejects.toMatchObject({ reason: "unsafe_archive" });
  });

  it("verifyTree allows a dangling link only when its target is plainly inside", async () => {
    const tree = join(root, "tree");
    await mkdir(join(tree, "node_modules/.bin"), { recursive: true });
    await symlink("../missing/cli.js", join(tree, "node_modules/.bin/tool"));
    await expect(verifyTree(tree)).resolves.toBeUndefined();
    await symlink("nothere/../.bin", join(tree, "node_modules/odd"));
    await expect(verifyTree(tree)).rejects.toMatchObject({ reason: "unsafe_archive" });
  });

  it("scanArchive accepts a real tar snapshot and counts its bytes", async () => {
    const archive = join(root, "ok.tgz");
    await writeFile(archive, await realTarSnapshot(LOCKFILE));
    const scan = await scanArchive(archive, { budgetBytes: 1024 * 1024 });
    expect(scan.entries).toBeGreaterThan(5);
    expect(scan.unpackedBytes).toBeGreaterThan(0);
  });

  it("a snapshot whose tree links outside node_modules is never uploaded", async () => {
    await writeFile(join(workspace, "sibling.js"), "x");
    env.FAKE_NPM_MODE = "";
    // A file: dependency link the way npm writes one: node_modules/x -> ../sibling.js
    const npmPath = join(root, "fake-npm-link");
    await writeFile(
      npmPath,
      FAKE_NPM.replace(
        'fs.writeFileSync("node_modules/.package-lock.json"',
        'fs.symlinkSync("../sibling.js", "node_modules/linked"); fs.writeFileSync("node_modules/.package-lock.json"',
      ),
    );
    await chmod(npmPath, 0o755);
    const result = await prepare({ npmPath });
    expect(result.result).toBe("cold");
    expect(state.uploads).toHaveLength(0);
    expect(events.some((entry) => entry.event === "snapshot_skipped" && entry.reason === "unsafe_archive")).toBe(true);
  });
});

// ---------------------------------------------------------------- consistency

describe("consistency", () => {
  it("rejects a restored tree whose hidden lockfile disagrees, leaving nothing behind", async () => {
    hitWith(await realTarSnapshot(LOCKFILE_V2));
    expect(await prepare()).toEqual({ result: "skipped", reason: "inconsistent" });
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("rejects a tree whose package.json differs from its hidden lockfile entry", async () => {
    hitWith(
      await realTarSnapshot(LOCKFILE, async (dir) => {
        await writeFile(
          join(dir, "node_modules/alpha/package.json"),
          JSON.stringify({ name: "alpha", version: "6.6.6" }),
        );
      }),
    );
    expect(await prepare()).toEqual({ result: "skipped", reason: "inconsistent" });
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
  });

  it("a cold install that comes out inconsistent is kept but not snapshotted", async () => {
    env.FAKE_NPM_MODE = "drift";
    expect(await prepare()).toEqual({
      result: "cold",
      key: "k".repeat(64),
      reason: "inconsistent",
      installMs: expect.any(Number),
    });
    expect(state.uploads).toHaveLength(0);
  });

  it("checkConsistency rules: optional may be absent, resolved ignored, extras and integrity are not", async () => {
    const tree = join(root, "tree");
    const make = async (packages: Record<string, object>) => {
      await rm(tree, { recursive: true, force: true });
      for (const [key, entry] of Object.entries(packages)) {
        await mkdir(join(tree, key), { recursive: true });
        await writeFile(
          join(tree, key, "package.json"),
          JSON.stringify({ version: (entry as { version: string }).version }),
        );
      }
      await writeFile(join(tree, "node_modules/.package-lock.json"), JSON.stringify({ packages }));
    };
    const lock = LOCKFILE as unknown as { packages: Record<string, Record<string, unknown>> };
    const installed = Object.fromEntries(
      Object.entries(lock.packages).filter(([key, entry]) => key !== "" && !entry.optional),
    );
    await make(Object.fromEntries(Object.entries(installed).map(([k, v]) => [k, { ...v, resolved: "x" }])));
    expect(await checkConsistency(tree, lock)).toEqual({ ok: true });
    await make({ ...installed, "node_modules/extra": { version: "1.0.0" } });
    expect((await checkConsistency(tree, lock)).ok).toBe(false);
    await make({ ...installed, "node_modules/alpha": { version: "1.0.0", integrity: "sha512-other" } });
    expect((await checkConsistency(tree, lock)).ok).toBe(false);
    const { "node_modules/beta": _beta, ...missing } = installed;
    await make(missing);
    expect((await checkConsistency(tree, lock)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- seal and time bounds

describe("seal and timeouts", () => {
  it("never uploads once the session is sealed", async () => {
    const result = await prepareProject({
      workspace,
      projectPath: ".",
      env,
      npmPath: join(root, "fake-npm"),
      log: (event, fields) => events.push({ event, ...fields }),
      auth: { base: env.WARDBY_NPM_PLAN_REGISTRY, token: "run-token" },
      budget: { remaining: 1024 * 1024 * 1024 },
      timeouts: { ...DEFAULT_TIMEOUTS },
      signal: new AbortController().signal,
      session: { sealed: true, closed: false, children: new Set<number>() },
    });
    expect(result.result).toBe("cold");
    expect(state.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
    expect(events.some((entry) => entry.event === "snapshot_skipped" && entry.reason === "sealed")).toBe(true);
  });

  it("seals when a call hangs, bounded by the HTTP timeout", async () => {
    state.hang = "GET /cache/npm/lookup";
    const started = Date.now();
    expect(await prepare({ timeouts: { httpMs: 300 } })).toEqual({ result: "skipped", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(state.seals).toBe(1);
  });

  it("kills a hung install at its timeout, cleans up, uploads nothing and seals", async () => {
    env.FAKE_NPM_MODE = "hang";
    const started = Date.now();
    expect(await prepare({ timeouts: { installMs: 400 } })).toEqual({ result: "skipped", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(state.uploads).toHaveLength(0);
    expect(state.seals).toBe(1);
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
  });

  it("the overall deadline aborts the work, seals, and nothing uploads after the seal", async () => {
    env.FAKE_NPM_MODE = "hang";
    expect(await prepare({ timeouts: { totalMs: 500 } })).toEqual({ result: "skipped", reason: "timeout" });
    expect(state.seals).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
    expect(state.calls.at(-1)).toBe("POST /cache/npm/seal");
  });

  it("never throws when the registry base is not a URL, and still answers skipped", async () => {
    const npmrc = join(root, "npmrc-bad");
    await writeFile(npmrc, "not a url/:_authToken=run-token\n");
    env.npm_config_registry = "not a url/";
    env.WARDBY_NPM_PLAN_REGISTRY = "not a url/";
    env.npm_config_userconfig = npmrc;
    await expect(prepare()).resolves.toMatchObject({ result: "skipped" });
  });

  it("after a deadline, a step that ignored it never puts node_modules in place", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    const started = Date.now();
    const result = await prepare({
      timeouts: { totalMs: 400, killGraceMs: 100, settleMs: 200 },
      testHooks: {
        beforeRename: () => new Promise((resolve) => setTimeout(resolve, Math.max(0, 1_500 - (Date.now() - started)))),
      },
    });
    expect(result).toEqual({ result: "skipped", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_400);
    expect(state.seals).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
  });

  it("seals even when the workspace .cache is not a directory", async () => {
    await symlink(root, join(workspace, ".cache"));
    expect(await prepare()).toEqual({ result: "skipped", reason: "cache_dir_unsafe" });
    expect(state.seals).toBe(1);
  });
});
