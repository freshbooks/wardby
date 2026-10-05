import { describe, expect, it } from "vitest";
import type { HelpCatalog, HelpPage } from "./catalog.js";
import { searchHelp } from "./search.js";

function page(overrides: Partial<HelpPage>): HelpPage {
  return {
    id: "general",
    title: "General help",
    summary: "General Wardby guidance.",
    audience: "all",
    tags: ["general"],
    appliesTo: ">=0.2.1",
    sourcePath: "general.md",
    markdown: "# General help",
    plainText: "General Wardby guidance.",
    headings: [{ level: 1, text: "General help", slug: "general-help" }],
    ...overrides,
  };
}

const catalog: HelpCatalog = {
  schemaVersion: 1,
  pages: [
    page({
      id: "deploy-gke",
      title: "Deploy Wardby on GKE Autopilot",
      summary: "Create a Kubernetes cluster with private Cloud SQL.",
      tags: ["deployment", "gke", "kubernetes"],
      plainText: "Deploy Wardby on GKE Autopilot. Create a Kubernetes cluster with private Cloud SQL.",
      headings: [
        { level: 1, text: "Deploy Wardby on GKE Autopilot", slug: "deploy-wardby-on-gke-autopilot" },
        { level: 2, text: "Prepare Cloud SQL", slug: "prepare-cloud-sql" },
      ],
    }),
    page({
      id: "coding-workers",
      title: "Troubleshoot coding workers",
      summary: "Configure Codex and Claude Code worker isolation.",
      tags: ["coding-agents", "isolation"],
      plainText: "Configure Codex and Claude Code worker isolation before a coding run.",
      headings: [{ level: 1, text: "Troubleshoot coding workers", slug: "troubleshoot-coding-workers" }],
    }),
    page({
      id: "review-fix-rounds",
      title: "Automatic review fix rounds",
      summary: "Let wardby fix its own review's findings on pull requests its runs opened, with a round cap.",
      tags: ["github", "code-review", "review_fix", "autofix", "fix-round", "pull-requests"],
      plainText:
        "Automatic review fix rounds. Link an agent with the review_fix trigger and wardby will try to fix its " +
        "own review's findings automatically. A round starts when wardby's own review check comes back " +
        "CHANGES_REQUESTED. Rounds are tracked with wardby-autofix labels on the pull request.",
      headings: [{ level: 1, text: "Automatic review fix rounds", slug: "automatic-review-fix-rounds" }],
    }),
    page({
      id: "related-pull-requests",
      title: "Related pull requests across repositories",
      summary:
        "Wardby lists the other pull requests from the same request in each pull request's description, " +
        "with a suggested merge order.",
      tags: ["github", "pull-requests", "multi-repo", "merge-order", "related", "siblings", "continuePriorRun"],
      plainText:
        "Related pull requests across repositories. Wardby adds a Related pull requests section to each pull " +
        "request's description, with links, state, and a suggested merge order. A follow-up task lists every " +
        "open sibling pull request with the continuePriorRun value that continues it.",
      headings: [
        {
          level: 1,
          text: "Related pull requests across repositories",
          slug: "related-pull-requests-across-repositories",
        },
        {
          level: 2,
          text: "Follow-up runs and sibling pull requests",
          slug: "follow-up-runs-and-sibling-pull-requests",
        },
      ],
    }),
    page({
      id: "agent-recipes",
      title: "Agent recipes",
      summary:
        "Two copyable agent setups, an architecture keeper and a per-language builder, with the version, " +
        "GitHub App, and webhook prerequisites each needs, written as a procedure an MCP assistant can follow.",
      tags: [
        "recipes",
        "examples",
        "architecture",
        "builder",
        "router",
        "mention",
        "push",
        "getting-started",
        "fan-out",
        "parallel-delegations",
        "parallelDelegations",
        "maxDelegationsPerRun",
      ],
      plainText:
        "Agent recipes. A lead that fans out: the calls run one after another unless you also set " +
        "parallelDelegations: true, which starts the delegations the lead makes in one turn together.",
      headings: [
        { level: 1, text: "Agent recipes", slug: "agent-recipes" },
        { level: 2, text: "Step 2C (optional): a lead that fans out", slug: "step-2c-optional-a-lead-that-fans-out" },
      ],
    }),
    page({
      id: "errors/continuation-closed",
      title: "Continuation's pull request is no longer open",
      summary: "A run asked to continue a pull request that was already merged or closed, so nothing was pushed.",
      tags: ["error", "vcs", "pull-requests", "continuation", "continuePriorRun"],
      plainText:
        "A run started with continuePriorRun reuses the branch and pull request the named run originally " +
        "opened. A run that stopped with category continuation_closed got a definite answer that the pull " +
        "request is no longer open: it was merged or closed.",
      headings: [
        {
          level: 1,
          text: "Continuation's pull request is no longer open",
          slug: "continuations-pull-request-is-no-longer-open",
        },
      ],
    }),
  ],
};

describe("searchHelp", () => {
  it("ranks exact title and tag matches before broad text matches", () => {
    expect(searchHelp(catalog, "gke").map((result) => result.page.id)).toEqual(["deploy-gke"]);
  });

  it("matches multiple partial and misspelled terms", () => {
    const [result] = searchHelp(catalog, "kuber clod sql");
    expect(result.page.id).toBe("deploy-gke");
    expect(result.matchedHeading?.text).toBe("Prepare Cloud SQL");
    expect(result.excerpt).toContain("Cloud SQL");
  });

  it("uses a stable id tie-breaker", () => {
    const tied: HelpCatalog = { ...catalog, pages: [...catalog.pages].reverse() };
    expect(searchHelp(tied, "coding").map((result) => result.page.id)).toEqual(["coding-workers"]);
  });

  it("finds the review fix rounds article by trigger name, tag, and feature phrase", () => {
    expect(searchHelp(catalog, "review_fix")[0]?.page.id).toBe("review-fix-rounds");
    expect(searchHelp(catalog, "autofix")[0]?.page.id).toBe("review-fix-rounds");
    expect(searchHelp(catalog, "fix round")[0]?.page.id).toBe("review-fix-rounds");
  });

  it("finds the related pull requests article by name, merge order, and continuation phrase", () => {
    expect(searchHelp(catalog, "related pull requests")[0]?.page.id).toBe("related-pull-requests");
    expect(searchHelp(catalog, "merge order")[0]?.page.id).toBe("related-pull-requests");
    expect(searchHelp(catalog, "continuePriorRun sibling")[0]?.page.id).toBe("related-pull-requests");
  });

  it("finds the continuation-closed error article by its failure category", () => {
    expect(searchHelp(catalog, "continuation_closed")[0]?.page.id).toBe("errors/continuation-closed");
  });

  it("finds the agent recipes article by the parallelDelegations flag", () => {
    expect(searchHelp(catalog, "parallelDelegations")[0]?.page.id).toBe("agent-recipes");
    expect(searchHelp(catalog, "parallel delegations")[0]?.page.id).toBe("agent-recipes");
  });
});
