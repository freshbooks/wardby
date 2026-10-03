import { describe, expect, it, vi } from "vitest";
import { pinNativeRunPricing } from "./run-pricing.js";
import { RoutingLlmProvider } from "../providers/llm/routing.js";
import { buildCatalog } from "../providers/llm/catalog.js";
import { SHIPPED_CATALOG } from "../providers/llm/catalog-shipped.js";
import type { CatalogLlmAdapter } from "../providers/llm/routing.js";

const adapter: CatalogLlmAdapter = {
  async *stream() {},
  countTokens: async () => 1,
  priceUsd: () => 0,
  withEntry: () => adapter,
};
const router = (rows = []) =>
  new RoutingLlmProvider([{ provider: "anthropic", adapter }], () => buildCatalog(SHIPPED_CATALOG, rows, "2026-10-03"));

function db(stored: { pricingVersion: string | null; pricingSnapshot: unknown }) {
  return {
    run: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => stored),
    },
  };
}

describe("pinNativeRunPricing", () => {
  it("records the current entry on a run that has none", async () => {
    const d = db({ pricingVersion: null, pricingSnapshot: null });
    const pinned = await pinNativeRunPricing(
      d,
      { id: "r1", pricingVersion: null, pricingSnapshot: null },
      "claude-sonnet-5",
      router(),
    );
    expect(pinned?.priceVersion).toBe("shipped:2026-10-03");
    expect(d.run.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", pricingVersion: null },
      data: {
        pricingVersion: "shipped:2026-10-03",
        pricingSnapshot: expect.objectContaining({ modelId: "claude-sonnet-5" }),
      },
    });
  });

  it("reuses a stored entry and never consults the catalog (a resumed run)", async () => {
    const stored = { ...SHIPPED_CATALOG.find((e) => e.modelId === "claude-sonnet-5")!, outputPerMTok: 77 };
    const d = db({ pricingVersion: "2026-10-01T00:00:00.000Z", pricingSnapshot: stored });
    const pinned = await pinNativeRunPricing(
      d,
      { id: "r1", pricingVersion: "2026-10-01T00:00:00.000Z", pricingSnapshot: stored },
      "claude-sonnet-5",
      router(),
    );
    expect(pinned?.entry.outputPerMTok).toBe(77);
    expect(d.run.updateMany).not.toHaveBeenCalled();
  });

  it("uses whatever a concurrent attempt stored first", async () => {
    const theirs = { ...SHIPPED_CATALOG.find((e) => e.modelId === "claude-sonnet-5")!, outputPerMTok: 55 };
    const d = {
      run: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findUnique: vi.fn(async () => ({ pricingVersion: "theirs", pricingSnapshot: theirs })),
      },
    };
    const pinned = await pinNativeRunPricing(
      d,
      { id: "r1", pricingVersion: null, pricingSnapshot: null },
      "claude-sonnet-5",
      router(),
    );
    expect(pinned).toEqual({ entry: expect.objectContaining({ outputPerMTok: 55 }), priceVersion: "theirs" });
  });

  it("throws model_unavailable for a disabled model before anything is written", async () => {
    const d = db({ pricingVersion: null, pricingSnapshot: null });
    const rows = [
      {
        ...SHIPPED_CATALOG.find((e) => e.modelId === "claude-sonnet-5")!,
        enabled: false,
        sourceUrl: "x",
        updatedBy: "a",
        updatedAt: new Date(),
      },
    ];
    await expect(
      pinNativeRunPricing(
        d,
        { id: "r1", pricingVersion: null, pricingSnapshot: null },
        "claude-sonnet-5",
        router(rows as never),
      ),
    ).rejects.toThrow(/reason: disabled/);
    expect(d.run.updateMany).not.toHaveBeenCalled();
  });

  it("returns undefined for an LLM provider that is not catalog-routed (test fakes)", async () => {
    const d = db({ pricingVersion: null, pricingSnapshot: null });
    expect(
      await pinNativeRunPricing(d, { id: "r1", pricingVersion: null, pricingSnapshot: null }, "m", adapter),
    ).toBeUndefined();
  });
});
