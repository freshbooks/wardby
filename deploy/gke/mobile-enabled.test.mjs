// Runs up.sh's WARDBY_MOBILE_ENABLED check under bash: only true/false (or unset
// or empty, meaning false) may pass; anything else stops the deploy before
// anything is rendered.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("./up.sh", import.meta.url)), "utf8");
const START = "# --- WARDBY_MOBILE_ENABLED check ---";
const END = "# --- end WARDBY_MOBILE_ENABLED check ---";
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

describe("deploy/gke/up.sh WARDBY_MOBILE_ENABLED", () => {
  it("is validated, substituted into the overlay, and covered by assert_no_placeholders", () => {
    expect(script.indexOf(START)).toBeGreaterThan(0);
    expect(script.indexOf(START)).toBeGreaterThan(script.indexOf("# --- end WARDBY_GITHUB_ALLOWED_ACCOUNTS check ---"));
    expect(script).toContain("value: wardby_mobile_enabled$|");
    expect(placeholderCheck).toContain("value: wardby_mobile_enabled");
  });

  it("accepts unset, empty, true and false, and says which", () => {
    const off = ["unset", "empty", "false"].map((k) =>
      run(k === "unset" ? {} : { WARDBY_MOBILE_ENABLED: k === "empty" ? "" : "false" }),
    );
    for (const r of off) {
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("up.sh: mobile sign-in is off.");
    }
    const on = run({ WARDBY_MOBILE_ENABLED: "true" });
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("up.sh: mobile sign-in is on.");
  });

  it("rejects anything else, including the overlay placeholder", () => {
    for (const bad of ["TRUE", "1", "yes", "wardby_mobile_enabled"]) {
      const result = run({ WARDBY_MOBILE_ENABLED: bad });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/WARDBY_MOBILE_ENABLED/);
    }
  });
});
