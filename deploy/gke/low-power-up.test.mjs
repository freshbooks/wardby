// WARDBY_LOW_POWER in deploy/gke/up.sh and deploy/kind-coding/up.sh: each script's own mode
// selection (the block between its "# low-power mode selection" markers) runs under bash, and
// its off-mode undo runs against a fake kubectl that records what it was asked to do.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const block = (script, marker) => {
  const start = script.indexOf(`# ${marker}\n`);
  const end = script.indexOf(`# end ${marker}\n`, start);
  return { start, text: start < 0 || end < 0 ? "" : script.slice(start, end) };
};

function runBlock(text, env, prelude = "") {
  const bin = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh\necho "$*" >> '${log}'\n`);
  chmodSync(join(bin, "kubectl"), 0o755);
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${prelude}\n${text}\necho "overlay=$OVERLAY"`], {
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
    encoding: "utf8",
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { ...result, calls };
}

const scripts = [
  {
    name: "deploy/gke/up.sh",
    script: read("./up.sh"),
    overlays: { off: "overlays/gke-autopilot", on: "overlays/gke-autopilot-low-power" },
    undo: 'kubectl -n "$NAMESPACE" delete hpa/wardby-control-plane role/wardby-power rolebinding/wardby-power --ignore-not-found',
    undoCall:
      "-n wardby-coding delete hpa/wardby-control-plane role/wardby-power rolebinding/wardby-power --ignore-not-found",
    prelude: "NAMESPACE=wardby-coding",
    banner: /echo "==> 9\/\$\{TOTAL_STEPS\} render and apply the overlay \(low-power mode: \$\{LOW_POWER_LABEL\}\)"/,
    firstAction: "terraform -chdir",
  },
  {
    name: "deploy/kind-coding/up.sh",
    script: read("../kind-coding/up.sh"),
    overlays: { off: "overlays/kind", on: "overlays/kind-low-power" },
    undo: 'kubectl --context "$KUBE_CONTEXT" -n wardby-coding delete role/wardby-power rolebinding/wardby-power --ignore-not-found',
    undoCall:
      "--context kind-wardby -n wardby-coding delete role/wardby-power rolebinding/wardby-power --ignore-not-found",
    prelude: 'KUBE_CONTEXT=kind-wardby\nMANIFEST_DIR="deploy/kind-coding"',
    banner: /echo "==> 8\/\$\{TOTAL_STEPS\} render and apply the manifests \(low-power mode: \$\{LOW_POWER_LABEL\}\)"/,
    firstAction: 'echo "==> 1/',
  },
];

describe.each(scripts)("$name WARDBY_LOW_POWER", (s) => {
  const selection = block(s.script, "low-power mode selection");
  const undo = block(s.script, "low-power undo");
  const select = (env) => runBlock(selection.text, env, s.prelude);

  it("validates the mode before doing anything", () => {
    expect(selection.start).toBeGreaterThan(0);
    expect(selection.start).toBeLessThan(s.script.indexOf(s.firstAction));
  });

  it("selects the plain overlay when unset or 0", () => {
    expect(select({}).stdout).toContain(`overlay=deploy/kind-coding/manifests/${s.overlays.off}\n`);
    expect(select({ WARDBY_LOW_POWER: "0" }).stdout).toContain(
      `overlay=deploy/kind-coding/manifests/${s.overlays.off}\n`,
    );
  });

  it("selects the low-power overlay when 1", () => {
    expect(select({ WARDBY_LOW_POWER: "1" }).stdout).toContain(
      `overlay=deploy/kind-coding/manifests/${s.overlays.on}\n`,
    );
  });

  it.each(["2", "true", "yes", "on", " 1", "1 "])("refuses WARDBY_LOW_POWER=%j", (value) => {
    const result = select({ WARDBY_LOW_POWER: value });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("overlay=");
    expect(result.stderr).toMatch(/WARDBY_LOW_POWER must be 0 or 1/);
  });

  it("applies the selected overlay, and prints the mode in the apply step's banner", () => {
    expect(s.script).toMatch(s.banner);
    expect(s.script).toMatch(/kubectl kustomize "\$OVERLAY"/);
  });

  it("removes what only low-power mode applies, in off mode only, after the apply", () => {
    expect(undo.start).toBeGreaterThan(s.script.search(s.banner));
    expect(undo.text).toContain(s.undo);
    const prelude = `${s.prelude}\nOVERLAY=unused`;
    const off = runBlock(undo.text, { WARDBY_LOW_POWER: "0" }, `${prelude}\nLOW_POWER=0`);
    expect(off.status).toBe(0);
    expect(off.calls.trim()).toBe(s.undoCall);
    const on = runBlock(undo.text, { WARDBY_LOW_POWER: "1" }, `${prelude}\nLOW_POWER=1`);
    expect(on.status).toBe(0);
    expect(on.calls).toBe("");
  });
});

describe("deploy/kind-coding/up.sh control plane reminder", () => {
  it("tells the operator the host-run control plane needs WARDBY_LOW_POWER=1 itself", () => {
    expect(read("../kind-coding/up.sh")).toMatch(/WARDBY_LOW_POWER=1.*wardby serve/);
  });
});
