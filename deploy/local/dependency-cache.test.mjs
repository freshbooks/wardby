// The quickstart's coding proxy always has a local blob store on a named
// volume; WARDBY_DEPENDENCY_CACHE alone switches the cache on.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadDependencyCacheConfig } from "../../src/config/dependency-cache.ts";

const compose = readFileSync(fileURLToPath(new URL("./docker-compose.quickstart-coding.yml", import.meta.url)), "utf8");
const proxy = parse(compose).services["coding-proxy"];

/** Compose's interpolation of the forms this file uses: ${NAME}, ${NAME:-default}, ${NAME:+alt}, ${NAME:?error}. */
function interpolate(value, shell) {
  return String(value).replace(/\$\{([A-Z0-9_]+)(?::([-+?])([^}]*))?\}/g, (_match, name, op, word) => {
    const set = shell[name] !== undefined && shell[name] !== "";
    if (op === "-") return set ? shell[name] : word;
    if (op === "+") return set ? word : "";
    if (op === "?" && !set) throw new Error(word);
    return shell[name] ?? "";
  });
}

/** The proxy container's environment for a given quickstart env file / shell. */
function proxyEnv(shell) {
  return Object.fromEntries(
    Object.entries(proxy.environment).map(([name, value]) => [name, interpolate(value, shell)]),
  );
}

describe("deploy/local quickstart coding proxy dependency cache", () => {
  it("is on only with WARDBY_DEPENDENCY_CACHE=true, then on the local blob store at the volume", () => {
    const base = { WARDBY_RUNTIME_IMAGE: "wardby:test" };
    for (const flag of [undefined, "", "false"]) {
      const env = proxyEnv({ ...base, WARDBY_DEPENDENCY_CACHE: flag });
      expect(env.BLOB_STORE).toBe("local");
      expect(loadDependencyCacheConfig(env)).toEqual({ enabled: false, reason: "disabled" });
    }
    const on = loadDependencyCacheConfig(proxyEnv({ ...base, WARDBY_DEPENDENCY_CACHE: "true" }));
    expect(on).toMatchObject({ enabled: true, blobStore: { kind: "local", localDir: "/var/lib/wardby/blobs" } });
  });

  it("keeps snapshots on a named volume at the directory the image makes writable", () => {
    expect(proxy.volumes).toContain("dependency-cache:/var/lib/wardby/blobs");
    expect(Object.keys(parse(compose).volumes)).toContain("dependency-cache");
    expect(readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8")).toContain(
      "chown node:node /var/lib/wardby/blobs",
    );
  });
});
