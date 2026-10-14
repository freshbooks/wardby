import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNpmClientLockfile } from "../../../coding/registry/npm-lockfile-formats.js";
import { RegistryError } from "../../../coding/registry/types.js";
import { parseLockfileOffThread } from "./lockfile-parse.js";

const PROXY = "http://wardby-proxy:8787/registry/npm/";
const OPTIONS = { maxEntries: 100, proxyRegistryUrl: PROXY };
const fixture = (name: string) =>
  readFileSync(new URL(`../../../coding/registry/fixtures/lockfiles/${name}`, import.meta.url), "utf8");

async function failure(promise: Promise<unknown>): Promise<[number, string] | string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof RegistryError ? [error.status, error.code] : String(error);
  }
  return "no error";
}

/** A lockfile far within the entry bound that YAML still takes seconds to
 *  read: one entry whose value is a ~20 MiB flow sequence. */
function slowLockfile(): string {
  return `lockfileVersion: '9.0'\nsnapshots:\n  a@1.0.0:\n    x: [${"aa, ".repeat(5_000_000)}a]\n`;
}

describe("parseLockfileOffThread", () => {
  for (const name of ["pnpm-lock-v9.yaml", "pnpm-lock-v6.yaml", "yarn-v1.lock", "yarn-berry.lock"]) {
    it(`gives the same entries and resolution as an in-process parse for ${name}`, async () => {
      const body = fixture(name);
      const direct = parseNpmClientLockfile(body, OPTIONS);
      const shipped = await parseLockfileOffThread("npm", body, OPTIONS, { timeoutMs: 10_000 });
      expect(shipped.entries).toEqual(direct.entries);
      expect(shipped.projects).toEqual(direct.projects);
      expect(shipped.integrity).toBe(direct.integrity);
      for (const entry of direct.entries) {
        for (const key of direct.dependencyKeys!(entry.path)) {
          expect(shipped.resolve(entry.path, key), `${entry.path} -> ${key}`).toEqual(direct.resolve(entry.path, key));
        }
      }
      expect(shipped.resolve("nowhere", "ms")).toBeUndefined();
    });
  }

  it("passes the parser's refusals through with their status and code", async () => {
    expect(
      await failure(parseLockfileOffThread("npm", "lockfileVersion: 5.4\n", OPTIONS, { timeoutMs: 10_000 })),
    ).toEqual([400, "wardby_lockfile_unsupported"]);
    expect(
      await failure(
        parseLockfileOffThread(
          "npm",
          fixture("pnpm-lock-v9.yaml"),
          { ...OPTIONS, maxEntries: 2 },
          { timeoutMs: 10_000 },
        ),
      ),
    ).toEqual([413, "wardby_lockfile_too_large"]);
  });

  it("stops a slow parse at its time bound without blocking the event loop", async () => {
    const body = slowLockfile();
    let worstLag = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      worstLag = Math.max(worstLag, now - last - 10);
      last = now;
    }, 10);
    const started = Date.now();
    try {
      expect(await failure(parseLockfileOffThread("npm", body, OPTIONS, { timeoutMs: 500 }))).toEqual([
        503,
        "wardby_plan_incomplete",
      ]);
    } finally {
      clearInterval(ticker);
    }
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(worstLag).toBeLessThan(200);
  }, 10_000);

  it("stops when the client goes away", async () => {
    const controller = new AbortController();
    const parse = parseLockfileOffThread("npm", slowLockfile(), OPTIONS, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    expect(await failure(parse)).toEqual([503, "wardby_plan_incomplete"]);
  }, 10_000);
});
