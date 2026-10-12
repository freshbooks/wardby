// Wardby's pre-agent dependency cache, run by trusted wardby code (the Codex
// worker driver and the Claude tool runner) before the agent starts.
//
// For an npm project with a committed package-lock.json it plans the
// lockfile with the registry proxy (the same request the npm shim sends),
// asks the proxy's dependency cache for a snapshot of node_modules made for
// exactly that lockfile, image and policy, and then either:
//   hit     - downloads it, verifies its sha256, checks every tar entry,
//             extracts it into a temp folder, checks the tree against the
//             lockfile and renames it into place;
//   nearest - restores the newest snapshot of an older lockfile the same way
//             (minus the lockfile check), lets `npm install` bring it up to
//             date, checks the tree, and snapshots the result;
//   cold    - runs `npm ci`, checks the tree, and snapshots it.
// It always seals the run's upload window at the end, so nothing the agent
// does can ever be uploaded.
//
// A snapshot is untrusted input (storage could be tampered with), so the
// archive is parsed here, in one place, and every entry is checked before
// anything is written; extraction then writes exactly the entries that were
// checked (no second tar implementation to disagree with this one).
//
// The cache never fails a run: every error becomes `skipped` with a stable
// reason code, and the agent installs as it would without the cache. Logs
// carry event names, codes and counts only: never tokens, URLs or npm output.
//
// Dependency-free on purpose (it runs before anything is installed).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, join, posix, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const MIB = 1024 * 1024;

/** Time bounds (ms). `transferMs` is the floor for a download or upload,
 *  which also gets `transferMsPerMiB` for every MiB it moves. After
 *  `totalMs` the work is aborted and gets `settleMs` to clean up; then the
 *  workspace is closed to it (no rename, removal or install) and it is sealed. */
export const DEFAULT_TIMEOUTS = Object.freeze({
  httpMs: 120_000,
  transferMs: 300_000,
  transferMsPerMiB: 1_000,
  installMs: 600_000,
  tarMs: 300_000,
  totalMs: 1_200_000,
  killGraceMs: 5_000,
  settleMs: 6_000,
});

/** The workspace budget when the caller names none and CODING_DISK_MB is unset. */
export const DEFAULT_BUDGET_MB = 2048;
/** Most entries a snapshot may hold (an inode bomb is not a byte bomb). */
export const MAX_ARCHIVE_ENTRIES = 1_000_000;
const MAX_JSON_BYTES = 1 * MIB;
const MAX_PAX_BYTES = 1 * MIB;
const MAX_NAME_BYTES = 4096;
const ROOT = "node_modules";

class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- tar parsing

/** Pulls exact byte counts out of an async iterable of Buffers. */
class ByteReader {
  constructor(iterable) {
    this.iterator = iterable[Symbol.asyncIterator]();
    this.chunks = [];
    this.buffered = 0;
    this.done = false;
  }

  async fill(count) {
    while (this.buffered < count && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
    return this.buffered >= count;
  }

  /** Exactly `count` bytes, or null at the end of the stream. */
  async read(count) {
    if (!(await this.fill(count))) return null;
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, count);
    const rest = all.subarray(count);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }

  /** Hands `count` bytes to `onChunk` piece by piece, without holding them all. */
  async consume(count, onChunk) {
    let left = count;
    while (left > 0) {
      if (this.buffered === 0 && !(await this.fill(1))) throw new Skip("unsafe_archive");
      const head = this.chunks[0];
      const take = Math.min(left, head.length);
      if (onChunk) await onChunk(head.subarray(0, take));
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.buffered -= take;
      left -= take;
    }
  }

  async close() {
    await this.iterator.return?.();
  }
}

function cString(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(block, start, length) {
  // A base-256 number (high bit set) is only needed past 8 GiB: refuse it.
  if (block[start] & 0x80) throw new Skip("unsafe_archive");
  const text = cString(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Skip("unsafe_archive");
  return text ? parseInt(text, 8) : 0;
}

function checksumOk(block) {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index];
  return octal(block, 148, 8) === sum;
}

/** The records of a pax extended header that matter here. */
function parsePax(data) {
  const out = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Skip("unsafe_archive");
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= space - offset || offset + length > data.length)
      throw new Skip("unsafe_archive");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw new Skip("unsafe_archive");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path" || key === "linkpath") out[key] = value;
    else if (key === "size") {
      if (!/^\d+$/.test(value)) throw new Skip("unsafe_archive");
      out.size = Number(value);
    }
    offset += length;
  }
  return out;
}

/**
 * Walks a gzipped tar file entry by entry. `onEntry({ path, type, size,
 * linkname, mode })` returns an optional data sink (an async function taking
 * each chunk) for a regular file. Supports ustar, GNU long names (L/K) and pax
 * extended headers (x); every other meta entry is refused.
 */
async function walkTar(file, { signal, maxStreamBytes }, onEntry) {
  let seen = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxStreamBytes) callback(new Skip("over_budget"));
      else callback(null, chunk);
    },
  });
  const source = createReadStream(file);
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  const decompressed = source
    .pipe(gunzip)
    .on("error", (error) => counter.destroy(error))
    .pipe(counter);
  const reader = new ByteReader(decompressed);
  try {
    let pending = {};
    for (;;) {
      signal?.throwIfAborted();
      const block = await reader.read(512);
      if (!block) throw new Skip("unsafe_archive"); // no end-of-archive marker
      if (block.every((byte) => byte === 0)) return; // end of archive
      if (!checksumOk(block)) throw new Skip("unsafe_archive");
      const type = String.fromCharCode(block[156] || 0x30);
      let size = octal(block, 124, 12);
      const padding = (512 - (size % 512)) % 512;
      if (type === "L" || type === "K" || type === "x") {
        if (size > (type === "x" ? MAX_PAX_BYTES : MAX_NAME_BYTES)) throw new Skip("unsafe_archive");
        const data = await reader.read(size + padding);
        if (!data) throw new Skip("unsafe_archive");
        const body = data.subarray(0, size);
        if (type === "x") pending = { ...pending, ...parsePax(body) };
        else {
          const end = body.indexOf(0);
          const text = body.subarray(0, end === -1 ? body.length : end).toString("utf8");
          if (type === "L") pending.path = text;
          else pending.linkpath = text;
        }
        continue;
      }
      const magic = block.subarray(257, 263).toString("latin1");
      const prefix = magic === "ustar\0" ? cString(block, 345, 155) : "";
      const name = cString(block, 0, 100);
      const path = pending.path ?? (prefix ? `${prefix}/${name}` : name);
      const linkname = pending.linkpath ?? cString(block, 157, 100);
      if (pending.size !== undefined) size = pending.size;
      pending = {};
      const sink = await onEntry({ path, type, size, linkname, mode: octal(block, 100, 8) });
      const dataPadding = (512 - (size % 512)) % 512;
      await reader.consume(size, sink);
      await reader.consume(dataPadding);
    }
  } finally {
    await reader.close().catch(() => undefined);
    source.destroy();
  }
}

/**
 * The rules every entry must pass, kept as state across one walk:
 * - only regular files ("0"), directories ("5") and symlinks ("2");
 * - a relative path under `node_modules/`, with no empty, "." or ".." segment;
 * - no path seen twice (counting the parents a path implies), and nothing
 *   beneath a symlink or a file;
 * - a symlink's target, taken from the link's own folder, stays in
 *   node_modules (and is never absolute);
 * - the summed file sizes and the entry count stay under the budget.
 */
class EntryRules {
  constructor(budgetBytes, maxEntries) {
    this.budgetBytes = budgetBytes;
    this.maxEntries = maxEntries;
    this.kinds = new Map();
    this.unpackedBytes = 0;
    this.entries = 0;
  }

  check(entry) {
    const kind =
      entry.type === "0" || entry.type === "\0"
        ? "file"
        : entry.type === "5"
          ? "dir"
          : entry.type === "2"
            ? "link"
            : null;
    if (!kind) throw new Skip("unsafe_archive");
    const path = kind === "dir" ? entry.path.replace(/\/+$/, "") : entry.path;
    if (!safeRelative(path)) throw new Skip("unsafe_archive");
    const segments = path.split("/");
    if (segments[0] !== ROOT || (segments.length === 1 && kind !== "dir")) throw new Skip("unsafe_archive");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join("/");
      const parentKind = this.kinds.get(parent);
      if (parentKind && parentKind !== "dir" && parentKind !== "implied") throw new Skip("unsafe_archive");
      if (!parentKind) this.kinds.set(parent, "implied");
    }
    const existing = this.kinds.get(path);
    // A folder's own entry may follow entries that implied it; nothing else repeats.
    if (existing && !(existing === "implied" && kind === "dir")) throw new Skip("unsafe_archive");
    this.kinds.set(path, kind);
    if (kind === "link") {
      const target = entry.linkname;
      if (!plainLinkTarget(path, target)) throw new Skip("unsafe_archive");
    }
    this.entries += 1;
    if (this.entries > this.maxEntries) throw new Skip("over_budget");
    if (kind === "file") {
      this.unpackedBytes += entry.size;
      if (this.unpackedBytes > this.budgetBytes) throw new Skip("over_budget");
    } else if (entry.size !== 0) throw new Skip("unsafe_archive");
    return { kind, path };
  }
}

function safeRelative(path) {
  if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A symlink target this module accepts: relative, `..` only as leading
 * segments, and inside node_modules when resolved from the link's folder.
 * The kernel applies `..` after following each link in the path, so a `..`
 * after a named segment (`a/s/../..`) can leave the folder that a lexical
 * normalize says it stays in when `a/s` is itself a link. npm's own links
 * (`.bin` entries, `file:` packages) only ever climb first, then descend.
 */
function plainLinkTarget(linkPath, target) {
  if (!target || target.includes("\0") || target.startsWith("/")) return false;
  let descended = false;
  for (const segment of target.split("/")) {
    if (segment === "..") {
      if (descended) return false;
    } else if (segment !== "" && segment !== ".") descended = true;
  }
  return insideRoot(posix.normalize(posix.join(posix.dirname(linkPath), target)));
}

function insideRoot(normalized) {
  return normalized === ROOT || normalized.startsWith(`${ROOT}/`);
}

/** Checks every entry of the archive without writing anything. */
export async function scanArchive(file, { budgetBytes, maxEntries = MAX_ARCHIVE_ENTRIES, signal } = {}) {
  const rules = new EntryRules(budgetBytes, maxEntries);
  await walkTar(file, { signal, maxStreamBytes: streamCap(budgetBytes, maxEntries) }, (entry) => {
    rules.check(entry);
    return undefined;
  });
  return { entries: rules.entries, unpackedBytes: rules.unpackedBytes };
}

// The decompressed stream is file bytes plus headers and padding; bound it too.
const streamCap = (budgetBytes, maxEntries) => budgetBytes + (maxEntries + 2) * 2048 + MAX_PAX_BYTES;

/** Writes the checked entries under `destination` (the same walk and rules,
 *  so what is written is exactly what was checked). No owner, no setuid. */
async function extractArchive(file, destination, { budgetBytes, maxEntries = MAX_ARCHIVE_ENTRIES, signal }) {
  const rules = new EntryRules(budgetBytes, maxEntries);
  let openHandle;
  try {
    await extractEntries();
  } finally {
    await openHandle?.close().catch(() => undefined);
  }
  async function extractEntries() {
    await walkTar(file, { signal, maxStreamBytes: streamCap(budgetBytes, maxEntries) }, async (entry) => {
      const { kind, path } = rules.check(entry);
      const target = join(destination, ...path.split("/"));
      if (kind === "dir") {
        await mkdir(target, { recursive: true, mode: 0o755 });
        return undefined;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      if (kind === "link") {
        await symlink(entry.linkname, target);
        return undefined;
      }
      // "wx": never follows or replaces anything already there.
      const handle = await open(target, "wx", entry.mode & 0o111 ? 0o755 : 0o644);
      if (entry.size === 0) {
        await handle.close();
        return undefined;
      }
      openHandle = handle;
      let written = 0;
      return async (chunk) => {
        written += chunk.length;
        await handle.write(chunk);
        if (written === entry.size) {
          openHandle = undefined;
          await handle.close();
        }
      };
    });
  }
}

/**
 * After extraction: only files, folders and symlinks that resolve inside
 * `<root>/node_modules`. Each link must pass the same target rule as the
 * scan, and its native realpath (the kernel's resolution, following every
 * link on the way) must be inside the real node_modules folder.
 *
 * A dangling link (no realpath) is accepted only on the target rule: its
 * folder is a real folder (the walk never descends through links), its
 * leading `..` segments are therefore resolved exactly as written, and every
 * later segment only descends, through real folders or through links that
 * are themselves checked here. So whatever later fills the gap is inside.
 * npm leaves such links for optional packages it skipped.
 */
export async function verifyTree(root, signal) {
  const top = join(root, ROOT);
  const realTop = await realpath(top);
  const stack = [top];
  while (stack.length) {
    signal?.throwIfAborted();
    const directory = stack.pop();
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isDirectory()) stack.push(path);
      else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (!plainLinkTarget(toPosix(path.slice(root.length + 1)), target)) throw new Skip("unsafe_archive");
        let real;
        try {
          real = await realpath(path); // native: resolves `..` after each link, like open() will
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw new Skip("unsafe_archive"); // ELOOP and the like
        }
        if (real !== realTop && !real.startsWith(realTop + sep)) throw new Skip("unsafe_archive");
      } else if (!info.isFile() || info.nlink > 1) throw new Skip("unsafe_archive");
    }
  }
}

const toPosix = (path) => path.split("\\").join("/");

// ---------------------------------------------------------------- consistency

/**
 * Compares npm's hidden lockfile (`node_modules/.package-lock.json`) and the
 * installed package.json files with the committed lockfile's `packages`.
 * Only keys under `node_modules/` are compared (the tree this module
 * restores). Compared: the set of paths, `version`, `integrity` (when the
 * lockfile has one) and `link`/`resolved` for links. Ignored, because npm
 * rewrites or derives them: `resolved` of registry packages (the registry
 * host is replaced), `dev`/`optional`/`devOptional`/`peer`, `license`,
 * `engines`, `os`/`cpu`, `bin`, `funding`, dependency maps and the like.
 * An `optional`/`devOptional` entry may be missing (npm skips optional
 * packages for another platform) but then must not be on disk either.
 */
export async function checkConsistency(projectRoot, lockfile, signal) {
  const fail = (detail) => ({ ok: false, detail });
  let hidden;
  try {
    hidden = JSON.parse(await readFile(join(projectRoot, ROOT, ".package-lock.json"), "utf8"));
  } catch {
    return fail("no_hidden_lockfile");
  }
  const installed = hidden && typeof hidden.packages === "object" && hidden.packages ? hidden.packages : null;
  if (!installed) return fail("no_hidden_lockfile");
  const wanted = lockfile.packages;
  const inTree = (key) => key.startsWith(`${ROOT}/`);
  for (const key of Object.keys(installed)) {
    if (!inTree(key)) continue;
    if (!Object.hasOwn(wanted, key)) return fail("extraneous");
  }
  for (const [key, entry] of Object.entries(wanted)) {
    signal?.throwIfAborted();
    if (!inTree(key) || !entry || typeof entry !== "object") continue;
    if (!safeRelative(key)) return fail("bad_key");
    const have = Object.hasOwn(installed, key) ? installed[key] : undefined;
    if (!have) {
      if (!entry.optional && !entry.devOptional) return fail("missing");
      if (await present(join(projectRoot, ...key.split("/")))) return fail("unlisted");
      continue;
    }
    if (Boolean(entry.link) !== Boolean(have.link)) return fail("link");
    if (entry.link) {
      if (entry.resolved !== have.resolved) return fail("link");
      continue;
    }
    if (entry.version !== have.version) return fail("version");
    if (entry.integrity !== undefined && entry.integrity !== have.integrity) return fail("integrity");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(projectRoot, ...key.split("/"), "package.json"), "utf8"));
    } catch {
      return fail("manifest");
    }
    if (manifest?.version !== entry.version) return fail("manifest");
  }
  return { ok: true };
}

async function present(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- HTTP

function timeoutSignal(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** Maps a failed call to a stable reason: a timeout (or the overall
 *  deadline) is `timeout`; anything else is `failure`. */
function asSkip(error, failure) {
  if (error instanceof Skip) return error;
  if (error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError") return new Skip("timeout");
  if (error?.name === "AbortError" && error?.cause instanceof Skip) return error.cause;
  if (error?.name === "AbortError") return new Skip("timeout");
  return new Skip(failure);
}

/** One request. Resolves with the response once headers arrive; the signal
 *  (and its timeout) keeps bounding the body after that. */
function request(url, { method = "GET", headers = {}, body, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const outgoing = client.request(url, { method, headers, signal }, resolve);
    outgoing.on("error", reject);
    if (body === undefined) outgoing.end();
    else if (Buffer.isBuffer(body)) outgoing.end(body);
    else pipeline(body, outgoing).catch((error) => outgoing.destroy(error));
  });
}

async function readJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error("too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function callJson(url, options, timeoutMs, failure) {
  try {
    const signal = timeoutSignal(options.signal, timeoutMs);
    const response = await request(url, { ...options, signal });
    return { status: response.statusCode ?? 0, body: await readJson(response) };
  } catch (error) {
    throw asSkip(error, failure);
  }
}

// ---------------------------------------------------------------- child processes

/** Runs a command with no output captured (npm output is never logged),
 *  in its own process group so a timeout kills everything it started. */
function run(command, args, { cwd, env, timeoutMs, killGraceMs, signal, session }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || session?.closed) {
      reject(asSkip(signal?.reason, "timeout"));
      return;
    }
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: "ignore", detached: true });
    } catch {
      reject(new Skip("install_failed"));
      return;
    }
    session?.children.add(child.pid);
    let reason;
    const kill = (why) => {
      if (reason) return;
      reason = why;
      const group = (sig) => {
        try {
          process.kill(-child.pid, sig);
        } catch {
          // already gone
        }
      };
      group("SIGTERM");
      setTimeout(() => group("SIGKILL"), killGraceMs).unref();
    };
    const timer = setTimeout(() => kill(new Skip("timeout")), timeoutMs);
    const onAbort = () => kill(asSkip(signal.reason, "timeout"));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => {
      session?.children.delete(child.pid);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Skip("install_failed"));
    });
    child.on("exit", (code) => {
      session?.children.delete(child.pid);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (reason) reject(reason);
      else resolve(code ?? 1);
    });
  });
}

// ---------------------------------------------------------------- setup

/** The plan URL and token, read exactly as the npm shim reads them: the
 *  registry is npm_config_registry, which must be WARDBY_NPM_PLAN_REGISTRY,
 *  and the token is that registry's _authToken in the driver's npmrc. */
async function registryAuth(env) {
  const registry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  const userconfig = env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG;
  if (!registry || !userconfig) return undefined;
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  if (!env.WARDBY_NPM_PLAN_REGISTRY || base !== env.WARDBY_NPM_PLAN_REGISTRY) return undefined;
  const prefix = `${base.replace(/^https?:/, "")}:_authToken=`;
  let npmrc;
  try {
    npmrc = await readFile(userconfig, "utf8");
  } catch {
    return undefined;
  }
  const line = npmrc.split(/\r?\n/).find((entry) => entry.trim().startsWith(prefix));
  const token = line?.trim().slice(prefix.length).trim();
  return token ? { base, token } : undefined;
}

/** The workspace budget in bytes: `budgetBytes`, else CODING_DISK_MB, else
 *  DEFAULT_BUDGET_MB; never more than the file system has free. */
async function workspaceBudget(workspace, env, budgetBytes) {
  const fromEnv = Number(env.CODING_DISK_MB);
  let budget = budgetBytes ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv * MIB : DEFAULT_BUDGET_MB * MIB);
  try {
    const fs = await statfs(workspace);
    budget = Math.min(budget, Number(fs.bavail) * Number(fs.bsize));
  } catch {
    // unknown: the budget alone
  }
  return { remaining: Math.max(0, budget) };
}

/** `<workspace>/.cache`, created if missing; refused when it is anything but
 *  a real folder (a repo could commit a `.cache` symlink). */
async function cacheDirectory(workspace) {
  const path = join(workspace, ".cache");
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Skip("cache_dir_unsafe");
  } catch (error) {
    if (error instanceof Skip) throw error;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch {
      throw new Skip("cache_dir_unsafe");
    }
  }
  return path;
}

const randomName = (prefix) => `${prefix}-${randomBytes(8).toString("hex")}`;

// ---------------------------------------------------------------- one project

/** The project's lockfile, read once: its exact bytes are what is planned,
 *  hashed and compared against. */
async function readProject(projectDir) {
  let bytes;
  try {
    bytes = await readFile(join(projectDir, "package-lock.json"));
  } catch {
    throw new Skip("no_lockfile");
  }
  let lockfile;
  let manifest;
  try {
    lockfile = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Skip("lockfile_unreadable");
  }
  if (!lockfile || typeof lockfile !== "object" || !(lockfile.lockfileVersion >= 2)) throw new Skip("lockfile_version");
  if (!lockfile.packages || typeof lockfile.packages !== "object") throw new Skip("lockfile_unreadable");
  try {
    manifest = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  } catch {
    throw new Skip("no_package_json");
  }
  if (manifest && typeof manifest === "object" && manifest.workspaces !== undefined) throw new Skip("workspaces");
  if (await present(join(projectDir, "npm-shrinkwrap.json"))) throw new Skip("shrinkwrap_present");
  if (await present(join(projectDir, ROOT))) throw new Skip("node_modules_present");
  if (!Object.keys(lockfile.packages).some((key) => key.startsWith(`${ROOT}/`))) throw new Skip("no_dependencies");
  return { bytes, lockfile, manifestBytes: await readFile(join(projectDir, "package.json")) };
}

/** Streams a snapshot to `file`, checking its length and sha256 on the way. */
async function download(context, id, file, maxBytes) {
  const { cacheBase, query, token, signal, timeouts } = context;
  const url = new URL(`blob/${id}?${query}`, cacheBase);
  // The size is unknown until the headers arrive: bound by maxBytes.
  const timeoutMs = timeouts.transferMs + Math.ceil(maxBytes / MIB) * timeouts.transferMsPerMiB;
  const bounded = timeoutSignal(signal, timeoutMs);
  let response;
  try {
    response = await request(url, { headers: { authorization: `Bearer ${token}` }, signal: bounded });
  } catch (error) {
    throw asSkip(error, "download_failed");
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Skip("download_failed");
  }
  const length = Number(response.headers["content-length"]);
  const expected = String(response.headers["x-wardby-sha256"] ?? "");
  if (!Number.isSafeInteger(length) || length < 0 || !/^[0-9a-f]{64}$/.test(expected)) {
    response.destroy();
    throw new Skip("download_failed");
  }
  if (length > maxBytes) {
    response.destroy();
    throw new Skip("too_large");
  }
  const hash = createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > length) callback(new Skip("size_mismatch"));
      else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(response, meter, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal: bounded });
  } catch (error) {
    throw asSkip(error, "download_failed");
  }
  if (received !== length) throw new Skip("size_mismatch");
  if (hash.digest("hex") !== expected) throw new Skip("sha_mismatch");
  return length;
}

/** Download, scan, extract into a temp folder, re-check the written tree,
 *  optionally check it against the lockfile, then rename into place. */
async function restore(context, project, id, maxBytes, { consistency }) {
  const { cacheDir, signal, budget } = context;
  const archive = join(cacheDir, `${randomName("dep")}.tgz`);
  const temp = join(cacheDir, randomName("dep-restore"));
  context.temps.push(archive, temp);
  const sizeBytes = await download(context, id, archive, maxBytes);
  const limit = Math.max(0, budget.remaining - sizeBytes);
  const scan = await scanArchive(archive, { budgetBytes: limit, signal }).catch((error) => {
    throw asSkip(error, "unsafe_archive");
  });
  await mkdir(temp, { mode: 0o700 });
  await extractArchive(archive, temp, { budgetBytes: limit, signal }).catch((error) => {
    throw asSkip(error, "unsafe_archive");
  });
  await rm(archive, { force: true });
  await verifyTree(temp, signal);
  // A sanity check that this is the tree for this lockfile, not an
  // integrity control: integrity is the sha256 the proxy recorded in its
  // database at upload time, verified above against the bytes received.
  if (consistency) {
    const check = await checkConsistency(temp, project.lockfile, signal);
    if (!check.ok) {
      context.log("inconsistent", { detail: check.detail });
      throw new Skip("inconsistent");
    }
  }
  const target = join(project.dir, ROOT);
  if (await present(target)) throw new Skip("node_modules_present");
  await context.testHooks?.beforeRename?.();
  // Past the deadline nothing new is put in place (checked right before the rename).
  if (signal.aborted || context.session.closed) throw asSkip(signal.reason, "timeout");
  context.created = target;
  await rename(join(temp, ROOT), target);
  await rm(temp, { recursive: true, force: true });
  // npm trusts its hidden lockfile only when it is newer than the folders.
  const now = new Date();
  await utimes(join(target, ".package-lock.json"), now, now).catch(() => undefined);
  budget.remaining -= scan.unpackedBytes;
  return sizeBytes;
}

async function install(context, project, args) {
  const { env, npmPath, signal, timeouts } = context;
  context.created = join(project.dir, ROOT);
  const started = Date.now();
  const code = await run(npmPath, args, {
    cwd: project.dir,
    env,
    timeoutMs: timeouts.installMs,
    killGraceMs: timeouts.killGraceMs,
    signal,
    session: context.session,
  });
  const installMs = Date.now() - started;
  context.log("install", { command: args[0], code, ms: installMs });
  if (code !== 0) throw new Skip("install_failed");
  return installMs;
}

/** Puts back package.json and package-lock.json if an install rewrote them:
 *  the agent's working tree must look exactly as it was committed. */
async function restoreCommitted(context, project) {
  if (context.session.closed) return;
  for (const [name, bytes] of [
    ["package-lock.json", project.bytes],
    ["package.json", project.manifestBytes],
  ]) {
    const path = join(project.dir, name);
    const now = await readFile(path).catch(() => undefined);
    if (!now || !now.equals(bytes)) await writeFile(path, bytes);
  }
}

/** Archives node_modules and uploads it. Never throws: the installed tree is
 *  fine either way, so a failure here only logs. */
async function snapshot(context, project, maxBytes) {
  const { cacheDir, cacheBase, query, token, signal, timeouts, session } = context;
  const archive = join(cacheDir, `${randomName("dep-snap")}.tgz`);
  context.temps.push(archive);
  const skip = (reason) => {
    context.log("snapshot_skipped", { reason });
    return undefined;
  };
  try {
    if (!(await present(join(project.dir, ROOT, ".package-lock.json")))) return skip("no_hidden_lockfile");
    const code = await run("tar", ["-czf", archive, "-C", project.dir, ROOT], {
      env: { PATH: context.env.PATH ?? process.env.PATH ?? "", COPYFILE_DISABLE: "1" },
      timeoutMs: timeouts.tarMs,
      killGraceMs: timeouts.killGraceMs,
      signal,
      session,
    }).catch((error) => asSkip(error, "tar_failed").reason);
    if (code !== 0) return skip(typeof code === "string" ? code : "tar_failed");
    const { size } = await stat(archive);
    if (size > maxBytes) return skip("too_large");
    // Upload only what a restore would accept.
    try {
      await scanArchive(archive, { budgetBytes: Number.MAX_SAFE_INTEGER, signal });
    } catch (error) {
      return skip(asSkip(error, "unsafe_archive").reason);
    }
    if (session.sealed || signal.aborted) return skip("sealed");
    const timeoutMs = timeouts.transferMs + Math.ceil(size / MIB) * timeouts.transferMsPerMiB;
    const result = await callJson(
      new URL(`blob?${query}`, cacheBase),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/gzip",
          "content-length": String(size),
        },
        body: createReadStream(archive),
        signal,
      },
      timeoutMs,
      "upload_failed",
    );
    const stored = result.status === 201 ? "stored" : result.status === 200 ? "exists" : "refused";
    context.log("snapshot", {
      status: result.status,
      stored,
      ...(stored === "refused" && typeof result.body?.error === "string" ? { code: result.body.error } : {}),
      bytes: size,
    });
    return stored === "refused" ? undefined : size;
  } catch (error) {
    return skip(asSkip(error, "upload_failed").reason);
  } finally {
    await rm(archive, { force: true }).catch(() => undefined);
  }
}

/**
 * The flow for one npm project (`projectPath` relative to the workspace;
 * only "." until subfolder projects are supported). Never throws.
 */
export async function prepareProject(options) {
  const { workspace, projectPath = ".", log, session } = options;
  const project = { dir: projectPath === "." ? workspace : join(workspace, ...projectPath.split("/")) };
  const context = { ...options, temps: [], created: undefined };
  try {
    Object.assign(project, await readProject(project.dir));
    context.cacheDir = await cacheDirectory(workspace);
    if (!context.auth) throw new Skip("no_registry");
    const { auth, timeouts, signal } = context;
    context.token = auth.token;
    context.cacheBase = new URL("/cache/npm/", auth.base);

    // The plan: the shim's request, with these exact bytes.
    const plan = await callJson(
      new URL("-/plan", auth.base),
      {
        method: "POST",
        headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
        body: project.bytes,
        signal,
      },
      timeouts.httpMs,
      "plan_failed",
    );
    if (plan.status !== 200 || typeof plan.body?.approved !== "number" || !Array.isArray(plan.body?.refused))
      throw new Skip("plan_failed");
    log("plan", { approved: plan.body.approved, refused: plan.body.refused.length });
    if (plan.body.refused.length > 0) return { result: "refused", reason: "plan_refused" };

    const lockHash = createHash("sha256").update(project.bytes).digest("hex");
    context.query = new URLSearchParams({ project: projectPath, lock: lockHash }).toString();
    const lookup = await callJson(
      new URL(`lookup?${context.query}`, context.cacheBase),
      { headers: { authorization: `Bearer ${auth.token}` }, signal },
      timeouts.httpMs,
      "lookup_failed",
    );
    if (lookup.status === 404) throw new Skip("cache_unavailable");
    if (lookup.status === 409 && typeof lookup.body?.error === "string" && /^[a-z_]{1,40}$/.test(lookup.body.error))
      throw new Skip(lookup.body.error);
    const answer = lookup.body;
    if (
      lookup.status !== 200 ||
      typeof answer?.key !== "string" ||
      !/^[a-z0-9]{1,64}$/.test(answer.key) ||
      typeof answer.hit !== "boolean" ||
      !Number.isSafeInteger(answer.maxBytes)
    )
      throw new Skip("lookup_failed");
    const nearestId =
      typeof answer.nearest?.id === "string" && /^[a-z0-9]{1,64}$/.test(answer.nearest.id)
        ? answer.nearest.id
        : undefined;
    log("lookup", { hit: answer.hit, nearest: Boolean(nearestId) });
    const key = answer.key;

    if (answer.hit) {
      const started = Date.now();
      const sizeBytes = await restore(context, project, key, answer.maxBytes, { consistency: true });
      context.created = undefined; // a verified hit stays
      return { result: "hit", key, sizeBytes, restoreMs: Date.now() - started };
    }

    let result = "cold";
    let restoreMs;
    let installMs;
    if (nearestId) {
      const started = Date.now();
      try {
        await restore(context, project, nearestId, answer.maxBytes, { consistency: false });
        restoreMs = Date.now() - started;
        result = "nearest";
      } catch (error) {
        const reason = asSkip(error, "internal_error").reason;
        if (reason === "timeout") throw error;
        // A rejected nearest is only a miss: clean up and install cold.
        log("nearest_rejected", { reason });
        await cleanup(context);
      }
    }
    if (result === "nearest") {
      try {
        installMs = await install(context, project, [
          "install",
          "--no-save",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ]);
      } finally {
        await restoreCommitted(context, project);
      }
    } else installMs = await install(context, project, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);

    const check = await checkConsistency(project.dir, project.lockfile, signal);
    if (!check.ok) {
      log("inconsistent", { detail: check.detail });
      // A tree npm ci built from the committed lockfile is what the agent
      // would install itself: keep it, but never snapshot it. A tree built
      // over a restored snapshot is removed.
      if (result === "nearest") throw new Skip("inconsistent");
      context.created = undefined;
      return { result, key, installMs, reason: "inconsistent" };
    }
    context.created = undefined;
    const sizeBytes = await snapshot(context, project, answer.maxBytes);
    return {
      result,
      key,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(restoreMs !== undefined ? { restoreMs } : {}),
      installMs,
    };
  } catch (error) {
    const reason = asSkip(error, "internal_error").reason;
    await cleanup(context);
    return { result: "skipped", reason };
  } finally {
    if (!context.session.closed)
      for (const path of context.temps) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Removes a node_modules this run created and every temp file. */
async function cleanup(context) {
  // Once the caller stopped waiting, the workspace is the agent's: touch nothing.
  if (context.session.closed) return;
  if (context.created) {
    await rm(context.created, { recursive: true, force: true }).catch(() => undefined);
    context.created = undefined;
  }
  for (const path of context.temps.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

// ---------------------------------------------------------------- entry point

/**
 * Restores or installs the workspace root's dependencies, then seals the
 * run's upload window. Never throws. `proxyUrl`/`token` override what the
 * registry environment names (the npm shim's npm_config_registry,
 * WARDBY_NPM_PLAN_REGISTRY and npmrc token).
 */
export async function prepareDependencies({
  workspace,
  env = process.env,
  proxyUrl,
  token,
  npmPath = "/opt/wardby/bin/npm",
  log = () => {},
  budgetBytes,
  timeouts: overrides = {},
  testHooks,
}) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...overrides };
  const say = (event, fields = {}) => {
    try {
      log(event, fields);
    } catch {
      // a logger never fails the cache
    }
  };
  const session = { sealed: false, closed: false, children: new Set() };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Skip("timeout")), timeouts.totalMs);
  let auth;
  let result;
  try {
    auth = await registryAuth(env);
    if (proxyUrl && (auth || token))
      auth = { token: auth?.token, base: new URL("/registry/npm/", proxyUrl).toString() };
    if (auth && token) auth = { ...auth, token };
    if (!auth?.token) auth = undefined;
    const budget = await workspaceBudget(workspace, env, budgetBytes);
    const work = prepareProject({
      workspace,
      projectPath: ".",
      env,
      npmPath,
      log: say,
      auth,
      budget,
      timeouts,
      signal: controller.signal,
      session,
      testHooks,
    });
    // The deadline aborts the work, which then has settleMs to clean up.
    // If it still has not settled, the session is closed (below) so it can
    // no longer rename, remove or install anything, nor upload.
    let grace;
    const late = new Promise((resolve) => {
      grace = setTimeout(() => resolve({ result: "skipped", reason: "timeout" }), timeouts.totalMs + timeouts.settleMs);
    });
    result = await Promise.race([work, late]);
    clearTimeout(grace);
  } catch {
    result = { result: "skipped", reason: "internal_error" };
  } finally {
    clearTimeout(deadline);
    session.sealed = true;
    session.closed = true;
    controller.abort(new Skip("sealed"));
    for (const pid of session.children) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (auth) {
      let status = 0;
      try {
        const sealed = await callJson(
          new URL("/cache/npm/seal", auth.base),
          { method: "POST", headers: { authorization: `Bearer ${auth.token}` } },
          timeouts.httpMs,
          "seal_failed",
        );
        status = sealed.status;
      } catch {
        // an unsealed session expires with its upload window
      }
      say("seal", { status });
    }
  }
  say("result", { result: result.result, ...(result.reason ? { reason: result.reason } : {}) });
  return result;
}
