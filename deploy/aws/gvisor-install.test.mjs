// Runs gvisor-install.sh against a local fake release (file:// URL): a good archive installs both
// binaries; a bad checksum, a missing download or missing settings install nothing and mask kubelet,
// so a sandbox node without gVisor never joins the cluster.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./gvisor-install.sh", import.meta.url));
const VERSION = "20260101.0";
let root, release, installDir, bin, systemctlLog, sha512;

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
      ...env,
    },
    encoding: "utf8",
  });

const good = () => ({ GVISOR_VERSION: VERSION, GVISOR_SHA512: sha512, GVISOR_BASE_URL: `file://${release}` });
const masked = () => existsSync(systemctlLog) && readFileSync(systemctlLog, "utf8").includes("mask kubelet.service");

describe("gvisor-install.sh", () => {
  it("installs runsc and the containerd shim, and the runsc config, from a verified archive", () => {
    const result = run(good());
    expect(result.status, result.stderr).toBe(0);
    for (const name of ["runsc", "containerd-shim-runsc-v1"]) {
      expect(existsSync(join(installDir, name))).toBe(true);
    }
    expect(readFileSync(join(root, "runsc.toml"), "utf8")).toMatch(/systemd-cgroup\s*=\s*"true"/);
    expect(masked()).toBe(false);
  });

  it("installs nothing and masks kubelet on a checksum mismatch", () => {
    const result = run({ ...good(), GVISOR_SHA512: "0".repeat(128) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum/);
    expect(existsSync(join(installDir, "runsc"))).toBe(false);
    expect(masked()).toBe(true);
  });

  it("installs nothing and masks kubelet when the download fails", () => {
    const result = run({ ...good(), GVISOR_VERSION: "20250101.0" });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(installDir, "runsc"))).toBe(false);
    expect(masked()).toBe(true);
  });

  it("masks kubelet when its settings are missing", () => {
    const result = run({ GVISOR_VERSION: VERSION, GVISOR_BASE_URL: `file://${release}` });
    expect(result.status).not.toBe(0);
    expect(masked()).toBe(true);
  });
});
