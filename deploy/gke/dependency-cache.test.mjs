// Runs up.sh's WARDBY_DEPENDENCY_CACHE check and the proxy-env injection under
// bash: off by default (no bucket env at all), on adds the three proxy env
// vars, anything else stops the deploy before anything is rendered.
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
const check = section("WARDBY_DEPENDENCY_CACHE check");
const inject = section("WARDBY_DEPENDENCY_CACHE proxy env");
const placeholderCheck = script.slice(
  script.indexOf("assert_no_placeholders() {"),
  script.indexOf("\n}\n", script.indexOf("assert_no_placeholders() {")),
);

const run = (env, body = "") =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${check}\n${body}\necho ok`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

const RENDERED = [
  "      containers:",
  "        - name: proxy",
  "          env:",
  "            - name: DATABASE_URL",
  "              value: wardby-proxy-database-url",
  "            - name: NODE_ENV",
  "              value: production",
  "",
].join("\n");

const render = (env) =>
  run(
    env,
    `DEPENDENCY_CACHE_BUCKET="\${DEPENDENCY_CACHE_BUCKET:-}"\n${inject}\nprintf '%s' "$RENDERED" | inject_dependency_cache_env`,
  );

describe("deploy/gke/up.sh WARDBY_DEPENDENCY_CACHE", () => {
  it("has both sections, in the apply step, with the bucket read from terraform", () => {
    expect(check).toContain("WARDBY_DEPENDENCY_CACHE");
    expect(inject).toContain("BLOB_STORE_GCS_BUCKET");
    expect(script).toContain("output -raw dependency_cache_bucket");
    expect(script).toContain("inject_dependency_cache_env");
  });

  it("is off by default: unset, empty and false say off and leave the render alone", () => {
    for (const env of [{}, { WARDBY_DEPENDENCY_CACHE: "" }, { WARDBY_DEPENDENCY_CACHE: "false" }]) {
      const result = render({ ...env, RENDERED });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("dependency cache is off");
      expect(result.stdout).not.toMatch(/BLOB_STORE|WARDBY_DEPENDENCY_CACHE"/);
      expect(result.stdout).toContain(RENDERED);
    }
  });

  it("when true, adds BLOB_STORE=gcs, the bucket and the flag to the proxy env, indented to match", () => {
    const result = render({ WARDBY_DEPENDENCY_CACHE: "true", DEPENDENCY_CACHE_BUCKET: "my-cache-bucket", RENDERED });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dependency cache is on");
    expect(result.stdout).toContain(
      [
        "            - name: BLOB_STORE",
        '              value: "gcs"',
        "            - name: BLOB_STORE_GCS_BUCKET",
        '              value: "my-cache-bucket"',
        "            - name: WARDBY_DEPENDENCY_CACHE",
        '              value: "true"',
      ].join("\n"),
    );
    // The DATABASE_URL placeholder is still there for the later substitution.
    expect(result.stdout).toContain("value: wardby-proxy-database-url");
  });

  it("stops when true but terraform has no bucket", () => {
    const result = render({ WARDBY_DEPENDENCY_CACHE: "true", DEPENDENCY_CACHE_BUCKET: "", RENDERED });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/dependency_cache_enabled/);
  });

  it("rejects anything but true or false", () => {
    for (const bad of ["TRUE", "1", "yes", "on"]) {
      const result = run({ WARDBY_DEPENDENCY_CACHE: bad });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/WARDBY_DEPENDENCY_CACHE must be true or false/);
    }
  });

  it("rejects a bucket name that is not a bucket name (no injection into the manifest)", () => {
    const result = render({ WARDBY_DEPENDENCY_CACHE: "true", DEPENDENCY_CACHE_BUCKET: 'x"\n  - evil', RENDERED });
    expect(result.status).not.toBe(0);
  });

  it("leaves no placeholder behind: the inject runs before the placeholder check", () => {
    expect(script.indexOf("inject_dependency_cache_env \\")).toBeGreaterThan(0);
    expect(placeholderCheck).toBeTruthy();
  });
});
