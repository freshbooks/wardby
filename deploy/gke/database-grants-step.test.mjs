// deploy/gke/up.sh applies the database grants (bootstrap-database-iam.sh) after the
// migrations and before the overlay, stops the deploy when they fail, and fails the
// deploy when its final check finds the coding proxy still missing a grant. The
// bootstrap itself takes only --check.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const script = read("./up.sh");
const bootstrap = read("./bootstrap-database-iam.sh");
const block = (marker) => {
  const start = script.indexOf(`# ${marker}\n`);
  const end = script.indexOf(`# end ${marker}\n`, start);
  return { start, text: start < 0 || end < 0 ? "" : script.slice(start, end) };
};
const run = (text, { cwd = ROOT, path = process.env.PATH, prelude = "" } = {}) =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${prelude}\n${text}\necho reached-the-next-step`], {
    cwd,
    env: { PATH: path },
    encoding: "utf8",
  });

describe("deploy/gke/up.sh step numbering", () => {
  it("numbers its 13 steps in order, once each", () => {
    expect(script).toContain("TOTAL_STEPS=13\n");
    const steps = [...script.matchAll(/^echo "==> (\d+)\/\$\{TOTAL_STEPS\} /gm)].map((m) => Number(m[1]));
    expect(steps).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  });
});

describe("deploy/gke/up.sh database grants step", () => {
  const grants = block("database grants");

  it("runs after the migrations and before the overlay is applied or rolled out", () => {
    expect(grants.start).toBeGreaterThan(script.indexOf('echo "    migrations applied"'));
    expect(script.indexOf('echo "==> 9/${TOTAL_STEPS} apply database grants"')).toBeGreaterThan(
      script.indexOf('echo "    migrations applied"'),
    );
    for (const later of [
      'echo "==> 10/${TOTAL_STEPS} render and apply the overlay',
      'echo "$OVERLAY_MANIFEST" | kubectl apply -f -',
      "rollout status deploy/",
    ]) {
      expect(script.indexOf(later)).toBeGreaterThan(grants.start);
    }
  });

  const withFakeBootstrap = (exitCode) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-bootstrap-"));
    mkdirSync(join(dir, "deploy/gke"), { recursive: true });
    const log = join(dir, "calls.log");
    writeFileSync(join(dir, "deploy/gke/bootstrap-database-iam.sh"), `echo "args:$*" >> '${log}'\nexit ${exitCode}\n`);
    const result = run(grants.text, { cwd: dir });
    return { ...result, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };

  it("runs the bootstrap in its default mode and goes on when it succeeds", () => {
    const result = withFakeBootstrap(0);
    expect(result.status).toBe(0);
    expect(result.calls).toBe("args:\n");
    expect(result.stdout).toContain("reached-the-next-step");
  });

  it("stops the deploy, non-zero, before the rollout when the grants fail", () => {
    const result = withFakeBootstrap(1);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("reached-the-next-step");
    expect(result.stderr).toMatch(/applying the database grants failed; nothing was rolled out/);
  });

  it("checks up front for the tools the bootstrap needs", () => {
    expect(script).toMatch(/for tool in terraform gcloud kubectl docker helm node curl openssl base64; do/);
  });
});

describe("deploy/gke/up.sh final proxy grant check", () => {
  const check = block("proxy grants check");
  // A fake kubectl whose `exec` answers like the in-pod query: the missing grants, exit 2.
  const fakeKubectl = (execBody) => {
    const bin = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
    writeFileSync(join(bin, "kubectl"), `#!/bin/sh\ncase "$*" in *" exec "*) ${execBody} ;; esac\n`);
    chmodSync(join(bin, "kubectl"), 0o755);
    return `${bin}:${process.env.PATH}`;
  };
  const prelude = (ok) => `NAMESPACE=wardby-coding\nDATABASE_OK=${ok}\nnew_pod() { echo proxy-1; }`;

  it("is found in up.sh, after the rollout", () => {
    expect(check.start).toBeGreaterThan(script.indexOf("rollout status deploy/wardby-control-plane"));
  });

  it("passes when the proxy has every grant", () => {
    const result = run(check.text, { path: fakeKubectl("exit 0"), prelude: prelude(true) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("coding proxy has every grant");
    expect(result.stdout).toContain("reached-the-next-step");
  });

  it("fails the deploy, non-zero, when a grant is missing", () => {
    const result = run(check.text, {
      path: fakeKubectl('echo "RegistryFetch INSERT"; exit 2'),
      prelude: prelude(true),
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("reached-the-next-step");
    expect(result.stderr).toContain("RegistryFetch INSERT");
    expect(result.stderr).toContain("the new pods cannot use the database");
  });

  it("fails the deploy, non-zero, when an earlier database check failed", () => {
    const result = run(check.text, { path: fakeKubectl("exit 0"), prelude: prelude(false) });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("reached-the-next-step");
  });

  it("no longer mentions password login", () => {
    expect(script).not.toMatch(/password-from-stdin|force-rotate/);
  });
});

describe("deploy/gke/bootstrap-database-iam.sh arguments", () => {
  const runBootstrap = (...args) =>
    spawnSync("bash", [fileURLToPath(new URL("./bootstrap-database-iam.sh", import.meta.url)), ...args], {
      // No terraform, gcloud or kubectl on PATH: a usage error comes before any tool check.
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });

  it.each([["--password-from-stdin"], ["--force-rotate"], ["--bogus"], ["--check", "--force-rotate"]])(
    "refuses %j with a usage error",
    (...args) => {
      const result = runBootstrap(...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/usage: .* \[--check\]/);
    },
  );

  it("has no password-login path left", () => {
    expect(bootstrap).not.toMatch(/password-from-stdin|force-rotate|FROM_STDIN|DATABASE_URL/);
  });
});
