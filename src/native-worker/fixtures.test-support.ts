/**
 * Fixtures shared by the native sandbox worker's database suites: a scripted catalog-routed model,
 * an in-memory datastore, an identity cipher, and a tool that touches every privileged bridge kind.
 */

import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import { buildCatalog } from "../providers/llm/catalog.js";
import { SHIPPED_CATALOG } from "../providers/llm/catalog-shipped.js";
import type { CatalogEntry } from "../providers/llm/catalog-types.js";
import { computeCost } from "../providers/llm/pricing-core.js";
import { RoutingLlmProvider, type CatalogLlmAdapter } from "../providers/llm/routing.js";
import type { LlmRequest, LlmStreamEvent } from "../providers/llm/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";

export const MODEL = "claude-haiku-4-5";

/** A catalog-routed model that plays a fixed script and records every request it was sent. */
export function scriptedModel(turns: LlmStreamEvent[][], beforeStream?: (call: number) => Promise<void>) {
  const requests: LlmRequest[] = [];
  let entry: CatalogEntry | undefined;
  const adapter: CatalogLlmAdapter = {
    async *stream(req) {
      requests.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
      await beforeStream?.(requests.length);
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

export const usage = (inputTokens: number, outputTokens: number) => {
  const entry = SHIPPED_CATALOG.find((e) => e.modelId === MODEL)!;
  return { inputTokens, outputTokens, costUsd: computeCost(entry, { inputTokens, outputTokens }) };
};

export const script = (): LlmStreamEvent[][] => [
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

export function memoryDatastore(
  seed: Record<string, DatastoreValue>,
): Datastore & { store: Map<string, DatastoreValue> } {
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

export const identityCipher: SecretCipher = {
  keyId: () => "test",
  encrypt: async (plaintext) => plaintext,
  decrypt: async (ciphertext) => ciphertext,
};
export const noMemory = {} as AgentMemoryStore;

// The tool reads a note, a secret, logs, and writes back: every privileged bridge kind the gateway serves.
export const TOOL_CODE = `
  const note = await datastore.get(params.key);
  const key = await secrets.get("api");
  console.log("looked up", params.key, "with", key);
  await datastore.set("notes/seen", { key: params.key, keyLength: key.length });
  return { note, keyLength: key.length };
`;
