import { describe, expect, it } from "vitest";
import { buildCatalog, rowFromRecord, shippedCatalog } from "./catalog.js";
import type { CatalogEntry, CatalogRow } from "./catalog-types.js";
import { ModelUnavailableError } from "./catalog-types.js";

const SHIPPED: CatalogEntry[] = [
  {
    provider: "anthropic",
    modelId: "claude-a",
    encoding: "o200k_base",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: ["high"],
    thinkingMode: "adaptive",
  },
  {
    provider: "openai",
    modelId: "gpt-a",
    encoding: "o200k_base",
    inputPerMTok: 2,
    outputPerMTok: 8,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 2,
    efforts: [],
    thinkingMode: "none",
  },
];
const AT = new Date("2026-10-04T10:00:00.000Z");
const row = (over: Partial<CatalogRow>): CatalogRow => ({
  ...SHIPPED[0],
  enabled: true,
  sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  updatedBy: "p-admin",
  updatedAt: AT,
  ...over,
});

describe("buildCatalog", () => {
  it("serves shipped entries with a shipped price version when there are no rows", () => {
    const c = buildCatalog(SHIPPED, [], "2026-10-03");
    expect(c.require("claude-a")).toMatchObject({
      origin: "shipped",
      priceVersion: "shipped:2026-10-03",
      inputPerMTok: 1,
    });
    expect(c.entries()).toHaveLength(2);
  });

  it("lets an enabled row replace the shipped entry completely and flags the difference", () => {
    const c = buildCatalog(SHIPPED, [row({ outputPerMTok: 6 })], "2026-10-03");
    expect(c.require("claude-a")).toMatchObject({
      origin: "override",
      priceVersion: AT.toISOString(),
      outputPerMTok: 6,
      shippedDiffers: true,
      sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
    });
  });

  it("reports shippedDiffers false when the override equals the shipped entry", () => {
    const c = buildCatalog(SHIPPED, [row({})], "2026-10-03");
    expect(c.require("claude-a").shippedDiffers).toBe(false);
  });

  it("removes a model whose row is disabled, and keeps it listable as disabled", () => {
    const c = buildCatalog(SHIPPED, [row({ enabled: false })], "2026-10-03");
    expect(c.get("claude-a")).toBeUndefined();
    expect(() => c.require("claude-a")).toThrow(ModelUnavailableError);
    try {
      c.require("claude-a");
    } catch (e) {
      expect((e as ModelUnavailableError).reason).toBe("disabled");
    }
    expect(c.disabledEntries().map((e) => e.modelId)).toEqual(["claude-a"]);
  });

  it("adds a model that has no shipped entry, with no shippedDiffers flag", () => {
    const c = buildCatalog(SHIPPED, [row({ modelId: "claude-new" })], "2026-10-03");
    const e = c.require("claude-new");
    expect(e.origin).toBe("override");
    expect(e.shippedDiffers).toBeUndefined();
  });

  it("throws not_in_catalog for an unknown model", () => {
    const c = buildCatalog(SHIPPED, [], "2026-10-03");
    expect(() => c.require("nope")).toThrow(/not in this deployment's model catalog/);
  });

  it("keeps the shipped entry when a row claims its model id under another provider", () => {
    const conflicts: string[] = [];
    const c = buildCatalog(SHIPPED, [row({ provider: "bedrock-claude", modelId: "gpt-a" })], "2026-10-03", (m) =>
      conflicts.push(m),
    );
    expect(c.require("gpt-a").provider).toBe("openai");
    expect(conflicts).toHaveLength(1);
  });

  it("keeps the first of two added rows that claim one model id under different providers", () => {
    const conflicts: string[] = [];
    const c = buildCatalog(
      SHIPPED,
      [row({ provider: "anthropic", modelId: "x" }), row({ provider: "openai", modelId: "x", thinkingMode: "none" })],
      "2026-10-03",
      (m) => conflicts.push(m),
    );
    expect(c.require("x").provider).toBe("anthropic");
    expect(conflicts).toHaveLength(1);
  });

  it("returns the shipped entry an override shadows", () => {
    const c = buildCatalog(SHIPPED, [row({ outputPerMTok: 6 })], "2026-10-03");
    expect(c.shippedEntry("claude-a")?.outputPerMTok).toBe(5);
  });
});

describe("rowFromRecord", () => {
  it("accepts a valid Prisma row", () => {
    expect(rowFromRecord({ ...row({}), efforts: ["high"] })).toMatchObject({ modelId: "claude-a", enabled: true });
  });
  it.each([
    ["provider", { provider: "azure" }],
    ["thinkingMode", { thinkingMode: "sometimes" }],
    ["efforts", { efforts: ["turbo"] }],
    ["rate", { cachedInputPerMTok: -1 }],
  ])("rejects a bad %s", (_label, over) => {
    expect(rowFromRecord({ ...row({}), ...over })).toBeNull();
  });

  it.each([
    ["an empty modelId", { modelId: "" }],
    ["a NaN rate", { cachedInputPerMTok: NaN }],
  ])("rejects %s", (_label, over) => {
    expect(rowFromRecord({ ...row({}), ...over })).toBeNull();
  });

  it.each([
    ["null", null],
    ["an array", []],
  ])("rejects a non-object input (%s)", (_label, value) => {
    expect(rowFromRecord(value as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe("shippedCatalog", () => {
  it("contains the shipped Haiku entry as manual thinking", () => {
    expect(shippedCatalog().require("claude-haiku-4-5").thinkingMode).toBe("manual");
  });
});
