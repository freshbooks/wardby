import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_MODULES, copyBuildModules } from "./copy-build-modules.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(repoRoot, "src");
const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Every non-test .ts file under src (generated code excluded). */
async function productSources(dir = srcRoot) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "generated") out.push(...(await productSources(path)));
    } else if (
      entry.name.endsWith(".ts") &&
      !/\.test(-support)?\.ts$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    )
      out.push(path);
  }
  return out;
}

describe("copy-build-modules", () => {
  it("lists every relative .mjs that compiled (non-test) TypeScript imports", async () => {
    const imported = new Set();
    for (const file of await productSources()) {
      const text = await readFile(file, "utf8");
      // Static imports and re-exports (a type-only one leaves nothing in the emitted JavaScript), and dynamic imports.
      const statics = text.matchAll(
        /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["'](\.{1,2}\/[^"']+\.mjs)["']/g,
      );
      for (const match of statics) if (!match[1]) imported.add(relative(srcRoot, resolve(dirname(file), match[2])));
      for (const match of text.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+\.mjs)["']\s*\)/g))
        imported.add(relative(srcRoot, resolve(dirname(file), match[1])));
    }
    expect(imported.size).toBeGreaterThan(0);
    expect([...imported].filter((module) => !BUILD_MODULES.includes(module))).toEqual([]);
  });

  it("copies each module and its declarations into the output folder", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "wardby-build-modules-"));
    dirs.push(outDir);
    await copyBuildModules({ outDir });
    for (const module of BUILD_MODULES) {
      expect((await stat(join(outDir, module))).isFile()).toBe(true);
      const copied = await import(join(outDir, module));
      expect(Object.keys(copied).length).toBeGreaterThan(0);
    }
  });

  it("runs as part of npm run build, after tsc", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.build).toMatch(/tsc -p tsconfig\.build\.json && node scripts\/copy-build-modules\.mjs/);
  });
});
