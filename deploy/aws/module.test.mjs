// Static invariants of the deploy/aws Terraform module that `terraform test` cannot see: values
// shared with the TypeScript code, the GKE module and the manifests, and the deployment rule that
// no identity is hardcoded (CLAUDE.md "Deployment").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(moduleDir, "..", "..");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".terraform" || name === ".terraform.lock.hcl") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const read = (name) => readFileSync(join(moduleDir, name), "utf8");
const moduleFiles = walk(moduleDir);
const tfSources = moduleFiles.filter((f) => f.endsWith(".tf")).map((f) => readFileSync(f, "utf8"));

/** The body of each `variable "name" { ... }` block in variables.tf, keyed by name. */
function variableBlocks() {
  const blocks = {};
  for (const chunk of read("variables.tf")
    .split(/^variable "/m)
    .slice(1)) {
    blocks[chunk.slice(0, chunk.indexOf('"'))] = chunk;
  }
  return blocks;
}

describe("deploy/aws hygiene", () => {
  it("hardcodes no account id: only AWS's documentation placeholders appear", () => {
    for (const file of moduleFiles) {
      const ids = readFileSync(file, "utf8").match(/(?<!\d)\d{12}(?!\d)/g) ?? [];
      const real = ids.filter((id) => id !== "111122223333" && id !== "123456789012");
      expect(real, relative(repoRoot, file)).toEqual([]);
    }
  });

  it("names none of our own hosts or test repositories", () => {
    // This file is skipped: it holds the pattern itself.
    for (const file of moduleFiles.filter((f) => !f.endsWith("module.test.mjs"))) {
      expect(readFileSync(file, "utf8"), relative(repoRoot, file)).not.toMatch(/wardby\.com|knock-knock/i);
    }
  });

  it("commits no tfvars other than the example", () => {
    const tfvars = moduleFiles.filter((f) => /\.tfvars(\.json)?$/.test(f));
    expect(tfvars.map((f) => relative(moduleDir, f))).toEqual([]);
  });

  it("gives every variable a type and a description", () => {
    const blocks = variableBlocks();
    expect(Object.keys(blocks).length).toBeGreaterThan(0);
    for (const [name, body] of Object.entries(blocks)) {
      expect(body, name).toMatch(/^\s*type\s*=/m);
      expect(body, name).toMatch(/^\s*description\s*=/m);
    }
  });

  it("configures no backend: state location is the operator's choice", () => {
    for (const source of tfSources) expect(source).not.toMatch(/^\s*backend\s+"/m);
  });
});
