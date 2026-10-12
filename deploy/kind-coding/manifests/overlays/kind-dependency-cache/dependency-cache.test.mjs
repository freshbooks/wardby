// The kind run-dependency-cache overlays give the coding proxy a local blob store;
// the plain kind overlays must not.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hasKubectl = spawnSync("kubectl", ["version", "--client"]).status === 0;
const overlays = fileURLToPath(new URL("..", import.meta.url));
const render = (name) => {
  const r = spawnSync("kubectl", ["kustomize", `${overlays}/${name}`], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout;
};
const upSh = readFileSync(fileURLToPath(new URL("../../../up.sh", import.meta.url)), "utf8");

describe("kind WARDBY_DEPENDENCY_CACHE", () => {
  it("up.sh validates the flag and picks the -dependency-cache overlay only when true", () => {
    expect(upSh).toContain("WARDBY_DEPENDENCY_CACHE must be true or false");
    expect(upSh).toContain('OVERLAY_DIR_NAME="${OVERLAY_DIR_NAME}-dependency-cache"');
  });

  describe.skipIf(!hasKubectl)("rendered (kubectl)", () => {
    it("is off in the plain kind overlays", () => {
      for (const name of ["kind", "kind-low-power"]) {
        expect(render(name)).not.toMatch(/BLOB_STORE|WARDBY_DEPENDENCY_CACHE|dependency-cache/);
      }
    });

    it("is on in the -dependency-cache overlays, with a local, non-durable emptyDir", () => {
      for (const name of ["kind-dependency-cache", "kind-low-power-dependency-cache"]) {
        const out = render(name);
        expect(out).toMatch(/name: BLOB_STORE\n\s+value: local/);
        expect(out).toMatch(/name: BLOB_STORE_LOCAL_DIR\n\s+value: \/var\/lib\/wardby\/blobs/);
        expect(out).toMatch(/name: WARDBY_DEPENDENCY_CACHE\n\s+value: "true"/);
        expect(out).toMatch(/emptyDir:\n\s+sizeLimit: 20Gi\n\s+name: dependency-cache/);
      }
      expect(render("kind-low-power-dependency-cache")).toContain("wardby-power");
    });
  });
});
