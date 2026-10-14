import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { npmAdapter } from "./npm.js";
import { npmClientLockfilePlan, npmClientLockfiles, parseNpmClientLockfile } from "./npm-lockfile-formats.js";
import { RegistryError } from "./types.js";

const PROXY = "http://wardby-proxy:8787/registry/npm/";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/lockfiles/${name}`, import.meta.url), "utf8");
const parse = (body: string) => parseNpmClientLockfile(body, { maxEntries: 100, proxyRegistryUrl: PROXY });

describe("npm client lockfiles", () => {
  it("are the npm adapter's plan and rewrite hooks, for npm, pnpm and yarn lockfiles", () => {
    expect(npmAdapter.lockfilePlan).toBe(npmClientLockfilePlan);
    expect(npmAdapter.lockfiles).toBe(npmClientLockfiles);
    expect(npmClientLockfiles.names).toEqual([
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]);
  });

  it("tells the formats apart by content", () => {
    const npm = parse(JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0" } } }));
    expect(npm.entries.map((entry) => entry.path)).toEqual(["node_modules/a"]);
    expect(parse(fixture("pnpm-lock-v9.yaml")).resolve("debug@4.4.3", "ms")?.version).toBe("2.1.3");
    expect(parse(fixture("pnpm-lock-v6.yaml")).resolve("/debug@4.4.3", "ms")?.version).toBe("2.1.3");
    expect(parse(fixture("yarn-v1.lock")).resolve("debug@^4.3.0", "ms")?.version).toBe("2.1.3");
    expect(parse(fixture("yarn-berry.lock")).integrity).toBe("registry");
  });

  it("refuses anything else as an unsupported lockfile", () => {
    for (const body of ["", "name: x\n", "# just a comment\n"]) {
      expect(() => parse(body)).toThrow(
        expect.objectContaining({ status: 400, code: "wardby_lockfile_unsupported" }) as RegistryError,
      );
    }
  });

  it("rewrites each lockfile by its name", () => {
    const pnpm = `packages:\n  a@1.0.0:\n    resolution: {integrity: sha512-a, tarball: ${PROXY}-/tarball/a/1.0.0}\n`;
    const yarn = `# yarn lockfile v1\n\na@^1:\n  version "1.0.0"\n  resolved "${PROXY}a/-/a-1.0.0.tgz"\n`;
    const npm = `{"packages":{"node_modules/a":{"resolved":"${PROXY}-/tarball/a/1.0.0"}}}`;
    expect(npmClientLockfiles.normalize(pnpm, PROXY, "pnpm-lock.yaml")).toBe(
      "packages:\n  a@1.0.0:\n    resolution: {integrity: sha512-a}\n",
    );
    expect(npmClientLockfiles.normalize(yarn, PROXY, "yarn.lock")).toContain(
      'resolved "https://registry.yarnpkg.com/a/-/a-1.0.0.tgz"',
    );
    expect(npmClientLockfiles.normalize(npm, PROXY, "package-lock.json")).toContain(
      '"resolved":"https://registry.npmjs.org/a/-/a-1.0.0.tgz"',
    );
  });
});
