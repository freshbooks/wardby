// Runs up.sh's WARDBY_GITHUB_ALLOWED_ACCOUNTS check under bash: a malformed list
// must stop the deploy before anything is rendered; unset or empty is allowed
// (the App then serves only its owner).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("./up.sh", import.meta.url)), "utf8");
const START = "# --- WARDBY_GITHUB_ALLOWED_ACCOUNTS check ---";
const END = "# --- end WARDBY_GITHUB_ALLOWED_ACCOUNTS check ---";
const check = script.slice(script.indexOf(START), script.indexOf(END) + END.length);
const placeholderCheck = script.slice(
  script.indexOf("assert_no_placeholders() {"),
  script.indexOf("\n}\n", script.indexOf("assert_no_placeholders() {")),
);

const run = (env) =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${check}\necho ok`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

describe("deploy/gke/up.sh WARDBY_GITHUB_ALLOWED_ACCOUNTS", () => {
  it("is validated, substituted into the overlay, and covered by assert_no_placeholders", () => {
    expect(script.indexOf(START)).toBeGreaterThan(0);
    expect(script).toContain("value: wardby-github-allowed-accounts$|");
    expect(placeholderCheck).toContain("value: wardby-github-allowed-accounts");
  });

  it("accepts unset, empty, and a comma-separated list of logins", () => {
    expect(run({}).stdout).toContain("ok");
    expect(run({ WARDBY_GITHUB_ALLOWED_ACCOUNTS: "" }).stdout).toContain("ok");
    expect(run({ WARDBY_GITHUB_ALLOWED_ACCOUNTS: "acme,acme-labs" }).stdout).toContain("ok");
  });

  it("rejects anything else, including a wildcard, before rendering", () => {
    for (const bad of ["*", "acme/repo", "acme labs", "-acme", "acme,,x"]) {
      const result = run({ WARDBY_GITHUB_ALLOWED_ACCOUNTS: bad });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/WARDBY_GITHUB_ALLOWED_ACCOUNTS/);
    }
  });
});
