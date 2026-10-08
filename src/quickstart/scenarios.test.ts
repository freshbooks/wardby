import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildHelpCatalog } from "../help/catalog.js";
import { SCENARIOS, scenarioMenuLines } from "./scenarios.js";

describe("quickstart scenario menu", () => {
  it("lists six scenarios, each naming help articles that exist", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const ids = new Set(catalog.pages.map((page) => page.id));
    expect(SCENARIOS).toHaveLength(6);
    for (const scenario of SCENARIOS) {
      expect(scenario.articles.length, scenario.ask).toBeGreaterThan(0);
      for (const article of scenario.articles) expect(ids, `${scenario.ask} -> ${article}`).toContain(article);
    }
  });

  it("offers no GitHub scenario", () => {
    for (const scenario of SCENARIOS) expect(scenario.ask).not.toMatch(/github|pull request/i);
  });

  it("shows the builder-then-reviewer scenario only when the coding step ran", () => {
    const withCoding = scenarioMenuLines({ codingRan: true, mcpConfigured: true }).join("\n");
    const without = scenarioMenuLines({ codingRan: false, mcpConfigured: true }).join("\n");
    expect(withCoding).toContain("Run local-builder with a task, then have local-reviewer review the branch");
    expect(without).not.toContain("local-reviewer review the branch");
    // Numbering stays consecutive either way.
    expect(withCoding).toMatch(/ 1\. "Run local-builder[\s\S]* 6\. "Help me plan out a GKE deployment"/);
    expect(without).toMatch(/ 1\. "Let local-builder[\s\S]* 5\. "Help me plan out a GKE deployment"/);
    expect(without).not.toMatch(/ 6\. /);
  });

  it("names each scenario's articles, and every scenario the plan lists", () => {
    const text = scenarioMenuLines({ codingRan: true, mcpConfigured: true }).join("\n");
    for (const [ask, article] of [
      ["Let local-builder install more packages", "coding-packages"],
      ["Help me build a Wardby worker image for Go (or Java, Rust…)", "build-worker-image"],
      ["Set up a scheduled Wardby agent", "creating-agents"],
      ["Set up a Wardby architecture reviewer and keeper for this repo", "architecture-agent"],
      ["Help me plan out a GKE deployment", "deploy-gke"],
    ]) {
      expect(text).toMatch(new RegExp(`"${ask.replace(/[()…]/g, ".")}".*${article}`));
    }
    expect(text).toContain("deployment-targets");
  });

  it("asks the assistant when an MCP client is configured, and points at `help open` otherwise", () => {
    const configured = scenarioMenuLines({ codingRan: true, mcpConfigured: true }).join("\n");
    expect(configured).toMatch(/ask your assistant/i);
    const plain = scenarioMenuLines({ codingRan: true, mcpConfigured: false }).join("\n");
    expect(plain).not.toMatch(/ask your assistant/i);
    expect(plain).toContain("npx @wardby/cli@latest help open <article>");
  });
});
