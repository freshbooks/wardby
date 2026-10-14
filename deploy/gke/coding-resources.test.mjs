// Runs up.sh's CODING_MEMORY_MB / CODING_CPUS check and the control-plane env
// injection under bash: unset leaves the render alone, valid values add their
// env entries after WARDBY_MOBILE_ENABLED, anything else stops the deploy.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("./up.sh", import.meta.url)), "utf8");
const section = (name) => {
  const start = `# --- ${name} ---`;
  const end = `# --- end ${name} ---`;
  return script.slice(script.indexOf(start), script.indexOf(end) + end.length);
};
const check = section("CODING_MEMORY_MB and CODING_CPUS check");
const inject = section("CODING_MEMORY_MB and CODING_CPUS control-plane env");

const RENDERED = [
  "      containers:",
  "        - name: control-plane",
  "          env:",
  "            - name: WARDBY_MOBILE_ENABLED",
  "              value: wardby_mobile_enabled",
  "            - name: NODE_ENV",
  "              value: production",
  "",
].join("\n");

const render = (env) =>
  spawnSync(
    "bash",
    ["-c", `set -euo pipefail\n${check}\n${inject}\nprintf '%s' "$RENDERED" | inject_coding_resources_env`],
    { env: { PATH: process.env.PATH, RENDERED, ...env }, encoding: "utf8" },
  );

describe("deploy/gke/up.sh CODING_MEMORY_MB and CODING_CPUS", () => {
  it("has both sections and pipes the render through the injection", () => {
    expect(check).toContain("CODING_CPUS");
    expect(inject).toContain("inject_coding_resources_env()");
    expect(script).toContain("| inject_coding_resources_env \\");
  });

  it("leaves the render alone when both are unset or empty", () => {
    for (const env of [{}, { CODING_MEMORY_MB: "", CODING_CPUS: "" }]) {
      const result = render(env);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(RENDERED);
    }
  });

  it("adds both entries after WARDBY_MOBILE_ENABLED, in its indentation", () => {
    const result = render({ CODING_MEMORY_MB: "6144", CODING_CPUS: "2" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("coding pods get 6144 MiB of memory");
    expect(result.stdout).toContain("coding pods get 2 CPUs");
    expect(result.stdout).toContain(
      [
        "              value: wardby_mobile_enabled",
        "            - name: CODING_MEMORY_MB",
        '              value: "6144"',
        "            - name: CODING_CPUS",
        '              value: "2"',
        "            - name: NODE_ENV",
      ].join("\n"),
    );
  });

  it("adds only the one that is set", () => {
    const result = render({ CODING_CPUS: "1.5" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('- name: CODING_CPUS\n              value: "1.5"');
    expect(result.stdout).not.toContain("CODING_MEMORY_MB");
  });

  it("refuses memory that is not an integer between 1024 and 32768", () => {
    for (const value of ["abc", "6g", "512", "40000", "06144", "-1"]) {
      const result = render({ CODING_MEMORY_MB: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CODING_MEMORY_MB must be an integer between 1024 and 32768");
    }
  });

  it("refuses CPUs that are not a number between 0.25 and 16", () => {
    for (const value of ["abc", "2c", "0.1", "17", "-1", "1e2"]) {
      const result = render({ CODING_CPUS: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CODING_CPUS must be a number between 0.25 and 16");
    }
  });
});
