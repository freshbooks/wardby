/**
 * The load-test mock upstream must never be switched on by a real
 * deployment: only the kind-load overlay may name its variables.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const DEPLOY = join(ROOT, "deploy");
const ALLOWED = join("deploy", "kind-coding", "manifests", "overlays", "kind-load") + sep;
const VARIABLES = ["WARDBY_LOAD_TEST", "WARDBY_CODING_PROXY_MOCK_UPSTREAM"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === ".terraform" || name === "node_modules") return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("mock upstream deploy guard", () => {
  it("only the kind-load overlay names the mock upstream variables", () => {
    const offenders = files(DEPLOY)
      .map((path) => relative(ROOT, path))
      .filter((rel) => !rel.startsWith(ALLOWED) && !rel.endsWith(".md"))
      .filter((rel) => VARIABLES.some((v) => readFileSync(join(ROOT, rel), "utf8").includes(v)));
    expect(offenders).toEqual([]);
  });

  it("the kind-load overlay does set both", () => {
    const env = readFileSync(join(ROOT, ALLOWED, "proxy-load-env.yaml"), "utf8");
    for (const v of VARIABLES) expect(env).toContain(v);
  });
});
