// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// z-index per selector, read from the app's stylesheet (top-level rules only).
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const zIndex = new Map<string, number>();
for (const rule of css.split("}")) {
  const [selectors, body] = rule.split("{");
  const z = /z-index:\s*(\d+)/.exec(body ?? "");
  if (!selectors || !z) continue;
  for (const s of selectors.split(",")) zIndex.set(s.trim(), Number(z[1]));
}
const zOf = (selector: string) => zIndex.get(selector) ?? 0;

describe("stacking order", () => {
  it("puts dialogs above the canvas message, menus, the timeline tooltip and toasts", () => {
    const dialog = zOf(".dialog-backdrop");
    for (const layer of [
      ".flow-empty",
      ".server-menu .popover",
      ".agent-filter .popover",
      ".timeline-tooltip",
      ".toast",
    ]) {
      expect(zIndex.has(layer), `${layer} has a z-index`).toBe(true);
      expect(dialog, `${layer} is below dialogs`).toBeGreaterThan(zOf(layer));
    }
  });
});
