import { describe, expect, it } from "vitest";

import {
  BUILDER_AGENT,
  BUILDER_PROMPT,
  REVIEWER_AGENT,
  REVIEWER_PROMPT,
  seedCodingAgents,
  type AgentData,
  type CodingSeedInput,
  type SeedDb,
} from "./coding-seed.js";

function memoryDb() {
  const agents = new Map<string, AgentData & { id: string }>();
  const profiles = new Map<string, Record<string, unknown>>();
  const links = new Map<string, { agentId: string; repository: string; access: string }>();
  let next = 1;
  const db: SeedDb = {
    async findAgent(name) {
      return agents.get(name) ?? null;
    },
    async createAgent(data) {
      if (agents.has(data.name)) throw new Error("unique violation");
      const row = { ...data, id: `agent-${next++}` };
      agents.set(data.name, row);
      return { id: row.id };
    },
    async updateAgent(id, data) {
      const row = [...agents.values()].find((agent) => agent.id === id)!;
      Object.assign(row, data);
    },
    async upsertCodingProfile(agentId, profile) {
      profiles.set(agentId, profile);
    },
    async upsertLocalLink(agentId, link) {
      links.set(`${agentId}|local|${link.repository}`, { agentId, repository: link.repository, access: link.access });
    },
  };
  return { db, agents, profiles, links };
}

const input: CodingSeedInput = {
  ownerId: "owner-1",
  provider: "codex",
  builderModel: "gpt-5.6-luna",
  reviewerModel: "gpt-5.6-luna",
  repository: "local:/work/repo",
  baseRef: "main",
  services: ["postgres"],
};

describe("seedCodingAgents", () => {
  it("creates the builder and the reviewer with a local write link", async () => {
    const { db, agents, profiles, links } = memoryDb();
    const result = await seedCodingAgents(db, input);
    expect(result.builder).toMatchObject({ status: "created" });
    expect(result.reviewer).toMatchObject({ status: "created" });

    const builder = agents.get(BUILDER_AGENT)!;
    expect(builder).toMatchObject({ kind: "coding", budgetUsd: 2, systemPrompt: BUILDER_PROMPT, ownerId: "owner-1" });
    expect(profiles.get(builder.id)).toMatchObject({
      provider: "codex",
      repository: "local:/work/repo",
      baseRef: "main",
      services: ["postgres"],
      repositoryAuthorizedVia: "local_root",
      repositoryAuthorizedById: "owner-1",
    });

    const reviewer = agents.get(REVIEWER_AGENT)!;
    expect(reviewer).toMatchObject({ kind: "native", budgetUsd: 1, systemPrompt: REVIEWER_PROMPT });
    expect([...links.values()]).toEqual([{ agentId: reviewer.id, repository: "local:/work/repo", access: "write" }]);
  });

  it("is idempotent: a second run updates in place without duplicating agents or links", async () => {
    const { db, agents, links } = memoryDb();
    const first = await seedCodingAgents(db, input);
    const second = await seedCodingAgents(db, { ...input, baseRef: "develop" });
    expect(second.builder).toEqual({ id: (first.builder as { id: string }).id, status: "updated" });
    expect(second.reviewer).toEqual({ id: (first.reviewer as { id: string }).id, status: "updated" });
    expect(agents.size).toBe(2);
    expect(links.size).toBe(1);
  });

  it("leaves an agent of the same name that quickstart did not create alone", async () => {
    const { db, agents, profiles } = memoryDb();
    await db.createAgent({
      name: BUILDER_AGENT,
      kind: "coding",
      model: "m",
      budgetUsd: 9,
      systemPrompt: "mine",
      maxTurns: 1,
      ownerId: "someone",
    });
    const result = await seedCodingAgents(db, input);
    expect(result.builder.status).toBe("skipped");
    expect(agents.get(BUILDER_AGENT)!.budgetUsd).toBe(9);
    expect(profiles.size).toBe(0);
    expect(result.reviewer.status).toBe("created");
  });

  it("refuses a model the coding provider does not support", async () => {
    const { db } = memoryDb();
    await expect(seedCodingAgents(db, { ...input, provider: "claude-code" })).rejects.toThrow(/not supported/);
  });
});
