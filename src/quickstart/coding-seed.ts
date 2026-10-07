/**
 * Seeds the quickstart's two local-repository agents, idempotently:
 * `local-builder` (a coding agent whose repository is a trusted local folder)
 * and `local-reviewer` (a native agent with a write `local` link, so it can
 * publish reviews of the builder's branches). Re-running updates them in
 * place; an agent of the same name that quickstart did not create is left
 * alone. Writes go straight to the database, like seedDemo, with the same
 * authorization stamp the MCP tools give a local repository ("local_root").
 */
import { CodingProfileSchema } from "../coding/profile.js";
import { codingProviderSupportsModel, type CodingProvider } from "../coding/provider.js";

export const BUILDER_AGENT = "local-builder";
export const REVIEWER_AGENT = "local-reviewer";
const BUILDER_BUDGET_USD = 2;
const REVIEWER_BUDGET_USD = 1;
const REVIEWER_MAX_TURNS = 12;

export const BUILDER_PROMPT =
  "You are the Wardby quickstart coding agent, working in a local git repository. Make the smallest change that completes the task, follow the repository's existing style, add or update tests when behavior changes, and run the tests before you finish. End with a short summary of what you changed and how you verified it.";

export const REVIEWER_PROMPT = [
  "You are the Wardby quickstart review agent. Your task names one pull request: its number, its repository (local:/path), and its head commit.",
  "1. Call repo_pr_read with that repository and prNumber to get the description and the diff.",
  "2. When a change needs more context, read the surrounding code with repo_read_file at the head commit (repo_list_files lists what exists).",
  "3. Look for correctness bugs, missing or weak tests, security problems, and confusing code. Skip style a formatter would fix.",
  "4. Call repo_publish_review exactly once with the head commit, a verdict (APPROVE when nothing needs to change, CHANGES_REQUESTED for real defects, COMMENT otherwise), a one-line summary, a markdown body, and inline comments on changed lines, each with a severity (CRITICAL, MAJOR, MINOR, NIT).",
  "If repo_publish_review returns stale_head, stop: the branch moved on.",
].join("\n");

/** The database operations seeding needs; the default implementation is Prisma (quickstart/coding.ts). */
export interface SeedDb {
  findAgent(name: string): Promise<{ id: string; kind: string; systemPrompt: string } | null>;
  createAgent(data: AgentData): Promise<{ id: string }>;
  updateAgent(id: string, data: Partial<AgentData>): Promise<void>;
  upsertCodingProfile(agentId: string, profile: Record<string, unknown>): Promise<void>;
  upsertLocalLink(agentId: string, link: { repository: string; access: "write"; stamp: Stamp }): Promise<void>;
}

export interface AgentData {
  name: string;
  kind: "native" | "coding";
  model: string;
  budgetUsd: number;
  systemPrompt: string;
  maxTurns: number;
  ownerId: string;
}

interface Stamp {
  authorizedVia: "local_root";
  authorizedById: string;
  authorizedAt: Date;
}

export interface CodingSeedInput {
  ownerId: string;
  provider: CodingProvider;
  /** The coding agent's model; must be one the coding provider supports. */
  builderModel: string;
  /** The native reviewer's model (the quickstart's own provider). */
  reviewerModel: string;
  /** Canonical `local:/realpath`, already checked against the trusted roots. */
  repository: string;
  baseRef: string;
  /** Catalog service names the builder's runs may start. */
  services: string[];
}

export type SeedOutcome = { id: string; status: "created" | "updated" } | { status: "skipped"; reason: string };

export interface CodingSeedResult {
  builder: SeedOutcome;
  reviewer: SeedOutcome;
}

async function upsertAgent(db: SeedDb, data: AgentData): Promise<SeedOutcome> {
  const existing = await db.findAgent(data.name);
  if (existing && (existing.systemPrompt !== data.systemPrompt || existing.kind !== data.kind)) {
    return {
      status: "skipped",
      reason: `an agent named "${data.name}" already exists and was not created by quickstart; it was left unchanged`,
    };
  }
  if (existing) {
    const { name: _name, systemPrompt: _prompt, kind: _kind, ownerId: _owner, ...changes } = data;
    await db.updateAgent(existing.id, changes);
    return { id: existing.id, status: "updated" };
  }
  const created = await db.createAgent(data);
  return { id: created.id, status: "created" };
}

export async function seedCodingAgents(
  db: SeedDb,
  input: CodingSeedInput,
  now = new Date(),
): Promise<CodingSeedResult> {
  if (!codingProviderSupportsModel(input.provider, input.builderModel)) {
    throw new Error(`Model "${input.builderModel}" is not supported by coding provider "${input.provider}".`);
  }
  const stamp: Stamp = { authorizedVia: "local_root", authorizedById: input.ownerId, authorizedAt: now };
  // Parsed for its defaults and validation, exactly as create_agent would store it.
  const profile = CodingProfileSchema.parse({
    provider: input.provider,
    repository: input.repository,
    baseRef: input.baseRef,
    services: input.services,
  });

  const builder = await upsertAgent(db, {
    name: BUILDER_AGENT,
    kind: "coding",
    model: input.builderModel,
    budgetUsd: BUILDER_BUDGET_USD,
    systemPrompt: BUILDER_PROMPT,
    maxTurns: 10,
    ownerId: input.ownerId,
  });
  if (builder.status !== "skipped") {
    await db.upsertCodingProfile(builder.id, {
      ...profile,
      repositoryAuthorizedVia: stamp.authorizedVia,
      repositoryAuthorizedById: stamp.authorizedById,
      repositoryAuthorizedAt: stamp.authorizedAt,
    });
  }

  const reviewer = await upsertAgent(db, {
    name: REVIEWER_AGENT,
    kind: "native",
    model: input.reviewerModel,
    budgetUsd: REVIEWER_BUDGET_USD,
    systemPrompt: REVIEWER_PROMPT,
    maxTurns: REVIEWER_MAX_TURNS,
    ownerId: input.ownerId,
  });
  if (reviewer.status !== "skipped") {
    // Write access: repo_publish_review is a write tool on the link.
    await db.upsertLocalLink(reviewer.id, { repository: profile.repository, access: "write", stamp });
  }
  return { builder, reviewer };
}
