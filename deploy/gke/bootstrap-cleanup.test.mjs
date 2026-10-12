// bootstrap-database-iam.sh's cleanup, run for real against fake terraform, gcloud, curl,
// kubectl and sleep on PATH: whether the grants Job fails or the script is stopped with
// SIGTERM mid-run, it resets the owner password (a second password-set request) and
// deletes the Secret, the Job and the ConfigMap. Nothing here reaches a real cloud.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./bootstrap-database-iam.sh", import.meta.url));
const BASH = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

function fakes(jobState) {
  const bin = mkdtempSync(join(tmpdir(), "fake-bootstrap-bin-"));
  const log = join(bin, "calls.log");
  const write = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // terraform -chdir=... output -raw <name>
  write("terraform", 'case "$4" in private_ip_address) echo 10.0.0.5 ;; *) echo "fake-$4" ;; esac');
  write("gcloud", "echo fake-token");
  write("sleep", "/bin/sleep 0.1");
  write(
    "curl",
    `method=GET; url=""; prev=""
for a in "$@"; do
  case "$a" in https://*) url="$a" ;; esac
  [ "$prev" = -X ] && method="$a"
  prev="$a"
done
case " $* " in *" --data-binary "*) cat >/dev/null ;; esac
echo "curl $method $url" >> '${log}'
case "$method $url" in
  "GET "*/operations/*) printf '{"status": "DONE"}\\n200' ;;
  GET*) printf '{}\\n200' ;;
  *) printf '{\\n  "name": "op-1"\\n}\\n200' ;;
esac`,
  );
  write(
    "kubectl",
    `echo "kubectl $*" >> '${log}'
case "$*" in
  *"config get-contexts"*) echo fake-ctx ;;
  *" get job "*) ${jobState ? `echo ${jobState}` : ":"} ;;
  *) cat >/dev/null ;;
esac`,
  );
  return { path: `${bin}:/usr/bin:/bin`, log };
}

const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

function expectResetAndDeletes(lines) {
  const sets = lines.map((line, i) => [line, i]).filter(([line]) => /^curl (PUT|POST) /.test(line));
  expect(sets).toHaveLength(2); // the one-time password, then the reset
  const afterReset = lines.slice(sets[1][1] + 1).join("\n");
  expect(afterReset).toMatch(/delete secret wardby-database-bootstrap --ignore-not-found/);
  expect(afterReset).toMatch(/delete job wardby-database-grants --ignore-not-found/);
  expect(afterReset).toMatch(/delete configmap wardby-database-grants --ignore-not-found/);
}

describe("deploy/gke/bootstrap-database-iam.sh cleanup", () => {
  it("resets the password and deletes the Secret, Job and ConfigMap when the grants Job fails", () => {
    const { path, log } = fakes("Failed");
    const result = spawnSync(BASH, [SCRIPT], {
      env: { PATH: path, KUBE_CONTEXT: "fake-ctx" },
      input: "",
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the grants Job did not complete (Failed)");
    expect(result.stdout).toContain("reset fake-database_user to a password nobody holds");
    expectResetAndDeletes(calls(log));
  });

  it("does the same when stopped with SIGTERM while waiting for the Job", async () => {
    const { path, log } = fakes("");
    const child = spawn(BASH, [SCRIPT], {
      env: { PATH: path, KUBE_CONTEXT: "fake-ctx" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    const deadline = Date.now() + 10000;
    while (!calls(log).some((line) => line.includes(" get job ")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(stdout).toContain("reset fake-database_user to a password nobody holds");
    expectResetAndDeletes(calls(log));
  }, 20000);
});
