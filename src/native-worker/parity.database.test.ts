import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { executeRun, type NativeRunProviders } from "../core/runner.js";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import { buildCatalog } from "../providers/llm/catalog.js";
import { SHIPPED_CATALOG } from "../providers/llm/catalog-shipped.js";
import type { CatalogEntry } from "../providers/llm/catalog-types.js";
import { computeCost } from "../providers/llm/pricing-core.js";
import { RoutingLlmProvider, type CatalogLlmAdapter } from "../providers/llm/routing.js";
import type { LlmRequest, LlmStreamEvent } from "../providers/llm/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import type { WorkerLauncher } from "./gateway.js";
import { loopbackLauncher } from "./loopback.js";
import { createProcessLauncher } from "./stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// The real worker entry as a separate process, from source, with an empty environment.
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const processLauncher = createProcessLauncher({
  command: process.execPath,
  args: ["--import", "tsx", "src/native-worker/main.ts"],
  env: {},
  cwd: REPO_ROOT,
});

const MODEL = "claude-haiku-4-5";

/** A catalog-routed model that plays a fixed script and records every request it was sent. */
function scriptedModel(turns: LlmStreamEvent[][]) {
  const requests: LlmRequest[] = [];
  let entry: CatalogEntry | undefined;
  const adapter: CatalogLlmAdapter = {
    async *stream(req) {
      requests.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
      for (const event of turns[requests.length - 1] ?? []) yield event;
    },
    countTokens: async (_model, messages) => Math.ceil(JSON.stringify(messages).length / 4),
    priceUsd: (_model, usage) => computeCost(entry!, usage),
    withEntry: (e) => {
      entry = e;
      return adapter;
    },
  };
  const llm = new RoutingLlmProvider([{ provider: "anthropic", adapter }], () =>
    buildCatalog(SHIPPED_CATALOG, [], "parity"),
  );
  return { llm, requests };
}

const usage = (inputTokens: number, outputTokens: number) => {
  const entry = SHIPPED_CATALOG.find((e) => e.modelId === MODEL)!;
  return { inputTokens, outputTokens, costUsd: computeCost(entry, { inputTokens, outputTokens }) };
};

const script = (): LlmStreamEvent[][] => [
  [
    { type: "tool_call", id: "call_1", name: "lookup", argsJson: JSON.stringify({ key: "notes/a" }) },
    { type: "done", stopReason: "tool_use", usage: usage(400, 30) },
  ],
  [
    { type: "text", delta: "The note says " },
    { type: "text", delta: "hello." },
    { type: "done", stopReason: "end_turn", usage: usage(520, 12) },
  ],
];

function memoryDatastore(seed: Record<string, DatastoreValue>): Datastore & { store: Map<string, DatastoreValue> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (agentId, key) => store.get(`${agentId}:${key}`),
    set: async (agentId, key, value) => void store.set(`${agentId}:${key}`, value),
    delete: async (agentId, key) => void store.delete(`${agentId}:${key}`),
    list: async (agentId, prefix) =>
      [...store.keys()]
        .filter((k) => k.startsWith(`${agentId}:${prefix ?? ""}`))
        .map((k) => k.slice(agentId.length + 1)),
    getShared: async () => undefined,
    setShared: async () => {},
    deleteShared: async () => {},
    listShared: async () => [],
  };
}

const identityCipher: SecretCipher = {
  keyId: () => "test",
  encrypt: async (plaintext) => plaintext,
  decrypt: async (ciphertext) => ciphertext,
};
const noMemory = {} as AgentMemoryStore;

// The tool reads a note, a secret, logs, and writes back: every privileged bridge kind the gateway serves.
const TOOL_CODE = `
  const note = await datastore.get(params.key);
  const key = await secrets.get("api");
  console.log("looked up", params.key, "with", key);
  await datastore.set("notes/seen", { key: params.key, keyLength: key.length });
  return { note, keyLength: key.length };
`;

describe.skipIf(!process.env.DATABASE_URL)("native sandbox worker parity (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `parity-owner-${tag}`;
  const agentId = `parity-agent-${tag}`;
  const toolId = `parity-tool-${tag}`;
  const secretId = `parity-secret-${tag}`;

  afterAll(async () => {
    const runs = await db.run.findMany({ where: { agentId }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    await db.runModelUsage.deleteMany({ where: { runId: { in: runIds } } });
    await db.runAttribution.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agentTool.deleteMany({ where: { agentId } });
    await db.agentSecret.deleteMany({ where: { agentId } });
    await db.secret.deleteMany({ where: { id: secretId } });
    await db.tool.deleteMany({ where: { id: toolId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  async function seed() {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Answer from notes.",
        model: MODEL,
        budgetUsd: 1,
        maxTurns: 4,
        ownerId,
      },
    });
    await db.tool.create({
      data: {
        id: toolId,
        name: "lookup",
        description: "Reads a note.",
        paramsZod: "z.object({ key: z.string() })",
        jsonSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        code: TOOL_CODE,
        ownerId,
      },
    });
    await db.agentTool.create({
      data: {
        agentId,
        toolId,
        allowedSecrets: ["api"],
        allowedDatastorePrefixes: ["notes/"],
        capabilitiesGrantedById: ownerId,
      },
    });
    await db.secret.create({
      data: { id: secretId, name: "api", ciphertext: "s3cret-value-123", keyId: "test", ownerId },
    });
    await db.agentSecret.create({ data: { agentId, secretId, boundName: "api" } });
  }

  // Counts worker launches, so a test can prove the sandbox path (not the in-process engine) ran.
  let launches = 0;
  const counting = (launcher: WorkerLauncher): WorkerLauncher => ({
    run: (input, gateway, signal) => {
      launches += 1;
      return launcher.run(input, gateway, signal);
    },
  });

  async function runIn(mode: "control_plane" | "sandbox", launcher: WorkerLauncher = loopbackLauncher) {
    const { llm, requests } = scriptedModel(script());
    const datastore = memoryDatastore({ [`${agentId}:notes/a`]: "hello" });
    const texts: string[] = [];
    const providers: NativeRunProviders = {
      llm,
      engine: new NativeEngine(),
      datastore,
      secrets: identityCipher,
      memory: noMemory,
      // Both runs get the launcher: only the run's own snapshot decides where its engine runs.
      nativeSandbox: counting(launcher),
    };
    const run = await db.run.create({ data: { agentId, trigger: "manual", nativeExecutionMode: mode } });
    const finished = await executeRun(run.id, providers, db, (delta) => texts.push(delta));
    const modelUsage = await db.runModelUsage.findMany({ where: { runId: run.id } });
    return { finished, requests, datastore, texts, modelUsage };
  }

  it("produces the same answer, usage, tool effects, and model conversation in both modes", async () => {
    await seed();
    const inProcess = await runIn("control_plane");
    expect(launches).toBe(0);
    const sandboxed = await runIn("sandbox");
    const separateProcess = await runIn("sandbox", processLauncher);
    expect(launches).toBe(2);

    for (const result of [inProcess, sandboxed, separateProcess]) {
      expect(result.finished.status).toBe("succeeded");
      expect(result.finished.finalText).toBe("The note says hello.");
      expect(result.datastore.store.get(`${agentId}:notes/seen`)).toEqual({ key: "notes/a", keyLength: 16 });
    }
    const summary = (r: typeof inProcess) => ({
      status: r.finished.status,
      finalText: r.finished.finalText,
      turns: r.finished.turns,
      tokensIn: r.finished.tokensIn,
      tokensOut: r.finished.tokensOut,
      costUsd: Number(r.finished.costUsd),
      error: r.finished.error,
      texts: r.texts,
      modelUsage: r.modelUsage.map(({ runId: _runId, ...rest }) => ({ ...rest, costUsd: Number(rest.costUsd) })),
    });
    expect(summary(sandboxed)).toEqual(summary(inProcess));
    expect(summary(separateProcess)).toEqual(summary(inProcess));
    // The model saw the same conversation, tool result included.
    expect(sandboxed.requests).toEqual(inProcess.requests);
    expect(separateProcess.requests).toEqual(inProcess.requests);
    const toolResult = sandboxed.requests[1].messages.find((m) => m.role === "tool");
    expect(toolResult?.content).toContain('{"note":"hello","keyLength":16}');
  });
});
