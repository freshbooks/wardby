// Runs gvisor-install.sh against a local fake release (file:// URL): a good archive installs both
// binaries and writes the "installed" marker; a bad checksum, a missing download or missing
// settings install nothing and leave no marker. The kubelet drop-in (ConditionPathExists on the
// marker) is written first in every case, so a sandbox node without gVisor never starts kubelet
// and never joins the cluster.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./gvisor-install.sh", import.meta.url));
const VERSION = "20260101.0";
let root, release, installDir, bin, systemctlLog, dropIn, marker, sha512;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wardby-gvisor-"));
  const arch = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
  release = join(root, "release");
  const archDir = join(release, VERSION, arch);
  const payload = join(root, "payload");
  mkdirSync(archDir, { recursive: true });
  mkdirSync(payload);
  writeFileSync(join(payload, "runsc"), "#!/bin/sh\necho runsc\n");
  writeFileSync(join(payload, "containerd-shim-runsc-v1"), "#!/bin/sh\necho shim\n");
  const tarball = join(archDir, "gvisor.tar.bz2");
  expect(spawnSync("tar", ["-cjf", tarball, "-C", payload, "runsc", "containerd-shim-runsc-v1"]).status).toBe(0);
  sha512 = createHash("sha512").update(readFileSync(tarball)).digest("hex");

  installDir = join(root, "install");
  mkdirSync(installDir);
  bin = join(root, "bin");
  mkdirSync(bin);
  systemctlLog = join(root, "systemctl.log");
  dropIn = join(root, "systemd", "kubelet.service.d", "00-wardby-gvisor.conf");
  marker = join(root, "wardby", "gvisor-installed");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> "${systemctlLog}"\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  // macOS has shasum, not sha512sum; the node (AL2023) has sha512sum.
  if (spawnSync("sh", ["-c", "command -v sha512sum"]).status !== 0) {
    writeFileSync(join(bin, "sha512sum"), '#!/bin/sh\nexec shasum -a 512 "$@"\n');
    chmodSync(join(bin, "sha512sum"), 0o755);
  }
});

afterEach(() => spawnSync("rm", ["-rf", root]));

const run = (env) =>
  spawnSync("bash", [script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GVISOR_INSTALL_DIR: installDir,
      GVISOR_RUNSC_CONFIG: join(root, "runsc.toml"),
      GVISOR_KUBELET_DROPIN: dropIn,
      GVISOR_INSTALLED_MARKER: marker,
      ...env,
    },
    encoding: "utf8",
  });

const good = () => ({ GVISOR_VERSION: VERSION, GVISOR_SHA512: sha512, GVISOR_BASE_URL: `file://${release}` });
// kubelet is gated on the marker: the drop-in must exist and name it.
const gated = () => existsSync(dropIn) && readFileSync(dropIn, "utf8").includes(`ConditionPathExists=${marker}`);
const reloaded = () => existsSync(systemctlLog) && readFileSync(systemctlLog, "utf8").includes("daemon-reload");
const expectBlocked = (result) => {
  expect(result.status).not.toBe(0);
  expect(gated()).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(installDir, "runsc"))).toBe(false);
  expect(existsSync(join(installDir, "containerd-shim-runsc-v1"))).toBe(false);
};

describe("gvisor-install.sh", () => {
  it("installs runsc, the containerd shim and the runsc config from a verified archive, then writes the marker", () => {
    const result = run(good());
    expect(result.status, result.stderr).toBe(0);
    for (const name of ["runsc", "containerd-shim-runsc-v1"]) {
      expect(existsSync(join(installDir, name))).toBe(true);
    }
    expect(readFileSync(join(root, "runsc.toml"), "utf8")).toMatch(/systemd-cgroup\s*=\s*"true"/);
    expect(readFileSync(dropIn, "utf8")).toMatch(/^\[Unit\]\nConditionPathExists=/);
    expect(gated()).toBe(true);
    expect(reloaded()).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it("succeeds again on a second run, and a later failed run removes the marker", () => {
    expect(run(good()).status).toBe(0);
    const again = run(good());
    expect(again.status, again.stderr).toBe(0);
    expect(gated()).toBe(true);
    expect(existsSync(marker)).toBe(true);

    expect(run({ ...good(), GVISOR_SHA512: "0".repeat(128) }).status).not.toBe(0);
    expect(gated()).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("installs nothing and leaves no marker on a checksum mismatch", () => {
    const result = run({ ...good(), GVISOR_SHA512: "0".repeat(128) });
    expect(result.stderr).toMatch(/checksum/);
    expectBlocked(result);
  });

  it("installs nothing and leaves no marker when the download fails", () => {
    expectBlocked(run({ ...good(), GVISOR_VERSION: "20250101.0" }));
  });

  it("installs nothing and leaves no marker when its settings are missing", () => {
    expectBlocked(run({ GVISOR_VERSION: VERSION, GVISOR_BASE_URL: `file://${release}` }));
  });
});
