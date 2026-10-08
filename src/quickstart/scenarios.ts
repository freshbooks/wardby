/**
 * The scenario menu that ends the quickstart: things to ask an MCP-connected
 * assistant next, each with the help articles (search_help / get_help_article
 * ids) that guide it. GitHub setups are deliberately absent: a quickstart user
 * has no GitHub App; docs/getting-started.md keeps those paths.
 */
export interface Scenario {
  /** What to ask the assistant. */
  ask: string;
  /** Help article ids, the entry point first. */
  articles: string[];
  /** Shown only when the quickstart's coding step set up local-builder and local-reviewer. */
  needsCoding?: boolean;
}

export const SCENARIOS: Scenario[] = [
  {
    ask: "Run local-builder with a task, then have local-reviewer review the branch",
    articles: ["local-repositories"],
    needsCoding: true,
  },
  { ask: "Let local-builder install more packages", articles: ["coding-packages"], needsCoding: true },
  { ask: "Help me build a Wardby worker image for Go (or Java, Rust…)", articles: ["build-worker-image"] },
  { ask: "Set up a scheduled Wardby agent", articles: ["creating-agents"] },
  { ask: "Set up a Wardby architecture reviewer and keeper for this repo", articles: ["architecture-agent"] },
  { ask: "Help me plan out a GKE deployment", articles: ["deploy-gke", "deployment-targets"] },
];

export function scenarioMenuLines(opts: { codingRan: boolean; mcpConfigured: boolean }): string[] {
  const shown = SCENARIOS.filter((scenario) => opts.codingRan || !scenario.needsCoding);
  const lines = [
    "",
    opts.mcpConfigured
      ? "Next: ask your assistant for one of these (help articles in brackets):"
      : "Next: try one of these (help articles in brackets):",
  ];
  shown.forEach((scenario, index) => {
    lines.push(`  ${index + 1}. "${scenario.ask}"  [${scenario.articles.join(", ")}]`);
  });
  if (!opts.mcpConfigured) {
    lines.push(
      "With an MCP client connected (re-run quickstart with --client), your assistant follows the article.",
      "Read one yourself: npx @wardby/cli@latest help open <article>",
    );
  }
  return lines;
}
