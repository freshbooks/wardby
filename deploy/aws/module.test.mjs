// Static invariants of the deploy/aws Terraform module that `terraform test` cannot see: values
// shared with the TypeScript code, the GKE module and the manifests, and the deployment rule that
// no identity is hardcoded (CLAUDE.md "Deployment").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EKS_SANDBOX_NODE_LABEL,
  EKS_SANDBOX_TAINT_KEY,
  GVISOR_RUNTIME_CLASS,
} from "../../src/providers/jobs/kubernetes-platform.ts";

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

describe("deploy/aws sandbox node group", () => {
  const local = (name) => read("nodegroups.tf").match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, "m"))?.[1];

  it("labels and taints sandbox nodes exactly as the eks platform profile expects", () => {
    expect(local("sandbox_label_key")).toBe(EKS_SANDBOX_NODE_LABEL);
    expect(local("sandbox_taint_key")).toBe(EKS_SANDBOX_TAINT_KEY);
    expect(local("sandbox_value")).toBe(GVISOR_RUNTIME_CLASS);
  });
});

describe("deploy/aws database identities", () => {
  it("binds each database role to a service account the manifests define", () => {
    const manifests = walk(join(repoRoot, "deploy", "kind-coding", "manifests")).filter((f) => f.endsWith(".yaml"));
    const accounts = new Set(
      manifests.flatMap((f) =>
        [
          ...readFileSync(f, "utf8").matchAll(
            /kind: ServiceAccount\s*\nmetadata:\s*\n(?:\s+\S.*\n)*?\s+name: ([\w-]+)/g,
          ),
        ].map((m) => m[1]),
      ),
    );
    const block = read("database-iam.tf").match(/database_identities = \{([\s\S]*?)\}/)[1];
    const bound = [...block.matchAll(/=\s*"([\w-]+)"/g)].map((m) => m[1]);
    expect(bound).toEqual(["wardby-control-plane", "wardby-migrator", "wardby-coding-proxy", "wardby-native-gateway"]);
    for (const account of bound) expect(accounts, account).toContain(account);
  });
});

/** Quoted strings inside `<name> = toset([ ... ])` in a .tf source. */
function tosetList(source, name) {
  const body = source.match(new RegExp(`${name}\\s*=\\s*toset\\(\\[([\\s\\S]*?)\\]\\)`))?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("deploy/aws parity with the GKE deployment", () => {
  it("creates the same secret ids as deploy/gke", () => {
    const gke = tosetList(readFileSync(join(repoRoot, "deploy", "gke", "secrets.tf"), "utf8"), "secret_ids");
    expect(gke.length).toBeGreaterThan(0);
    expect(tosetList(read("secrets.tf"), "secret_ids").sort()).toEqual(gke.sort());
  });

  it("creates one ECR repository per docker-bake.hcl default target", () => {
    const bake = readFileSync(join(repoRoot, "deploy", "gke", "docker-bake.hcl"), "utf8");
    const targets = [
      ...bake.match(/group "default"\s*\{[\s\S]*?targets\s*=\s*\[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(tosetList(read("ecr.tf"), "image_names").sort()).toEqual(targets.sort());
  });
});

describe("deploy/aws README", () => {
  const readme = read("README.md");

  it("documents every input variable", () => {
    for (const name of Object.keys(variableBlocks())) expect(readme, name).toContain(`\`${name}\``);
  });

  it("documents every output", () => {
    const outputs = [...read("outputs.tf").matchAll(/^output "([\w]+)"/gm)].map((m) => m[1]);
    for (const name of outputs) expect(readme, name).toContain(`\`${name}\``);
  });
});
