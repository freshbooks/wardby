// Runs up.sh's CODING_MAX_DISK_MB check and the control-plane env injection
// under bash: unset leaves the render alone, a valid value adds one env entry
// after WARDBY_MOBILE_ENABLED, anything else stops the deploy.
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
const check = section("CODING_MAX_DISK_MB check");
const inject = section("CODING_MAX_DISK_MB control-plane env");

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
    ["-c", `set -euo pipefail\n${check}\n${inject}\nprintf '%s' "$RENDERED" | inject_coding_max_disk_env`],
    { env: { PATH: process.env.PATH, RENDERED, ...env }, encoding: "utf8" },
  );

describe("deploy/gke/up.sh CODING_MAX_DISK_MB", () => {
  it("has both sections and pipes the render through the injection", () => {
    expect(check).toContain("CODING_MAX_DISK_MB");
    expect(inject).toContain("inject_coding_max_disk_env()");
    expect(script).toContain("| inject_coding_max_disk_env \\");
  });

  it("leaves the render alone when unset or empty", () => {
    for (const env of [{}, { CODING_MAX_DISK_MB: "" }]) {
      const result = render(env);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(RENDERED);
    }
  });

  it("adds the env entry after WARDBY_MOBILE_ENABLED, in its indentation", () => {
    const result = render({ CODING_MAX_DISK_MB: "8192" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("coding workspaces may be up to 8192 MiB");
    expect(result.stdout).toContain(
      [
        "              value: wardby_mobile_enabled",
        "            - name: CODING_MAX_DISK_MB",
        '              value: "8192"',
        "            - name: NODE_ENV",
      ].join("\n"),
    );
  });

  it("refuses a value that is not an integer between 2048 and 32768", () => {
    for (const value of ["abc", "8g", "1024", "40000", "08192", "-1"]) {
      const result = render({ CODING_MAX_DISK_MB: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CODING_MAX_DISK_MB must be an integer between 2048 and 32768");
    }
  });
});
