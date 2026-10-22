/**
 * uv.lock rewriter. `uv sync --frozen` downloads from the URLs the lockfile
 * records and ignores the configured index, so a lock naming JFrog or PyPI
 * cannot install in the sandbox, which reaches only the coding proxy.
 * `rewriteUvLockToProxy` points every http(s) registry package at the proxy
 * and returns the maps `restoreUvLock` needs to put the original URLs back
 * before the workspace is collected. Only the matched URL values change; the
 * rest of the file stays byte-for-byte identical (no TOML round trip).
 */
import { normalizePypiName } from "../pypi-name.js";

export interface UvRewrite {
  content: string;
  /** What outbound needs when the file changed afterwards: proxy file URL -> original URL. */
  files: Record<string, string>;
  /** `<name>@<version>` (or `<name>` for an inline source without a version) -> original registry URL. */
  registries: Record<string, string>;
}

type UvMaps = Pick<UvRewrite, "files" | "registries">;

interface Block {
  name: string | null;
  version: string | null;
  /** The package's own `source = { registry = … }` value, if it has one. */
  registry: string | null;
}

interface Visitor {
  registry(key: string, value: string): string;
  url(value: string, block: Block): string;
}

const HTTP = /^https?:\/\//i;
const VERSION_LINE = /^version = \d+\s*$/m;
const PACKAGE_HEADER = /^\[\[package\]\]/m;
const NAME = /^name = "([^"\\]*)"/;
const VERSION = /^version = "([^"\\]*)"/;
const PACKAGE_REGISTRY = /^(source = \{ registry = ")([^"\\]*)(" \})/;
/** A dependency entry carrying its own source: `{ name = "x", version = "1", source = { registry = "…" } }`. */
const INLINE_REGISTRY =
  /(\{ name = "([^"\\]*)"(?:, version = "([^"\\]*)")?[^{}]*?source = \{ registry = ")([^"\\]*)(" \})/g;
/** `sdist = { url = "…" }` and each `{ url = "…" }` of `wheels`. */
const FILE_URL = /(\{\s*url\s*=\s*")([^"\\]*)(")/g;
/** Tables inside a package whose entries are dependency lists, which can carry inline sources. */
const DEPENDENCY_TABLE = /^\[package\.(?:optional-dependencies|dev-dependencies)\]/;

export function isUvLock(content: string): boolean {
  return VERSION_LINE.test(content) && PACKAGE_HEADER.test(content);
}

function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** The decoded file name a download URL ends in, without query or fragment. */
function filenameOf(url: string): string | null {
  const path = url.replace(/[#?].*$/, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  let filename: string;
  try {
    filename = decodeURIComponent(last);
  } catch {
    return null;
  }
  return filename && !filename.includes("/") ? filename : null;
}

function readBlock(lines: string[], start: number, end: number): Block {
  const block: Block = { name: null, version: null, registry: null };
  for (let i = start + 1; i < end && !lines[i].startsWith("["); i++) {
    const line = lines[i];
    block.name ??= line.match(NAME)?.[1] ?? null;
    block.version ??= line.match(VERSION)?.[1] ?? null;
    block.registry ??= line.match(PACKAGE_REGISTRY)?.[2] ?? null;
  }
  return block;
}

function visitBlock(lines: string[], start: number, end: number, visitor: Visitor): void {
  const block = readBlock(lines, start, end);
  const own = block.name === null ? null : `${block.name}@${block.version ?? ""}`;
  let root = true;
  let dependencies = false;
  for (let i = start + 1; i < end; i++) {
    let line = lines[i];
    if (line.startsWith("[")) {
      root = false;
      dependencies = DEPENDENCY_TABLE.test(line);
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    if (root && own !== null) {
      line = line.replace(PACKAGE_REGISTRY, (_m, open: string, value: string, close: string) => {
        return `${open}${visitor.registry(own, value)}${close}`;
      });
    }
    if (root || dependencies) {
      line = line.replace(
        INLINE_REGISTRY,
        (_m, open: string, name: string, version: string | undefined, value: string, close: string) => {
          return `${open}${visitor.registry(version === undefined ? name : `${name}@${version}`, value)}${close}`;
        },
      );
    }
    if (root) {
      line = line.replace(FILE_URL, (_m, open: string, value: string, close: string) => {
        return `${open}${visitor.url(value, block)}${close}`;
      });
    }
    lines[i] = line;
  }
}

function walk(content: string, visitor: Visitor): string {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("[[package]]")) continue;
    if (start >= 0) visitBlock(lines, start, i, visitor);
    start = i;
  }
  if (start >= 0) visitBlock(lines, start, lines.length, visitor);
  return lines.join("\n");
}

/** Points every http(s) registry package of `content` at the proxy's PyPI route (`registryUrl`). */
export function rewriteUvLockToProxy(content: string, registryUrl: string): UvRewrite {
  const base = withSlash(registryUrl);
  const index = `${base}simple`;
  const files: Record<string, string> = {};
  const registries: Record<string, string> = {};
  const rewritten = walk(content, {
    registry(key, value) {
      if (!HTTP.test(value) || value.replace(/\/$/, "") === index) return value;
      // Two origins for one key cannot both be restored: leave the second alone.
      if (lookup(registries, key) !== undefined && registries[key] !== value) return value;
      registries[key] = value;
      return index;
    },
    url(value, block) {
      if (block.registry === null || !HTTP.test(block.registry) || block.name === null) return value;
      if (!HTTP.test(value) || value.startsWith(base)) return value;
      const filename = filenameOf(value);
      if (filename === null) return value;
      const proxied = `${base}files/${normalizePypiName(block.name)}/${encodeURIComponent(filename)}`;
      if (lookup(files, proxied) !== undefined && files[proxied] !== value) return value;
      files[proxied] = value;
      return proxied;
    },
  });
  return { content: rewritten, files, registries };
}

/** Puts the original URLs back. Proxy URLs not in `maps` stay as they are and are returned in `unresolved`. */
export function restoreUvLock(
  content: string,
  maps: UvMaps,
  registryUrl: string,
): { content: string; unresolved: string[] } {
  const base = withSlash(registryUrl);
  const index = `${base}simple`;
  const unresolved = new Set<string>();
  const restored = walk(content, {
    registry(key, value) {
      if (value.replace(/\/$/, "") !== index) return value;
      const original = lookup(maps.registries, key);
      if (original === undefined) unresolved.add(key);
      return original ?? value;
    },
    url(value) {
      if (!value.startsWith(`${base}files/`)) return value;
      const original = lookup(maps.files, value);
      if (original === undefined) unresolved.add(value);
      return original ?? value;
    },
  });
  return { content: restored, unresolved: [...unresolved] };
}
