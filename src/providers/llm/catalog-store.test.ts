import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogStore,
  currentModelCatalog,
  installModelCatalog,
  refreshIntervalMs,
  uninstallModelCatalogForTests,
} from "./catalog-store.js";

const ROW = {
  provider: "anthropic",
  modelId: "claude-new",
  enabled: true,
  encoding: "o200k_base",
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  efforts: ["high"],
  thinkingMode: "adaptive",
  sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  updatedBy: "p-admin",
  updatedAt: new Date("2026-10-04T00:00:00Z"),
};

function db(rows: Record<string, unknown>[] | Error) {
  const findMany = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  return { modelCatalogEntry: { findMany }, findMany };
}
const quiet = { warn: vi.fn(), info: vi.fn() };

afterEach(() => {
  uninstallModelCatalogForTests();
  vi.useRealTimers();
});

describe("CatalogStore", () => {
  it("serves the shipped catalog before start, and shipped + rows after", async () => {
    const d = db([ROW]);
    const store = new CatalogStore(d, { log: quiet });
    expect(store.current().get("claude-new")).toBeUndefined();
    await store.start();
    expect(store.current().require("claude-new").origin).toBe("override");
    expect(store.current().require("claude-haiku-4-5").origin).toBe("shipped");
    store.close();
  });

  it("fails start when the database is unreachable", async () => {
    const store = new CatalogStore(db(new Error("ECONNREFUSED")), { log: quiet });
    await expect(store.start()).rejects.toThrow(/model catalog.*ECONNREFUSED/);
  });

  it("swaps in a new catalog on each poll and keeps the last good one when a poll fails", async () => {
    vi.useFakeTimers();
    let rows: Record<string, unknown>[] | Error = [];
    const findMany = vi.fn(async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    const store = new CatalogStore({ modelCatalogEntry: { findMany } }, { intervalMs: 1000, log });
    await store.start();
    rows = [ROW];
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.current().get("claude-new")).toBeDefined();
    rows = new Error("blip");
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.current().get("claude-new")).toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "models.catalog.refresh_failed" }),
      expect.any(String),
    );
    store.close();
  });

  it("skips and logs a malformed row instead of failing the load", async () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    const store = new CatalogStore(db([{ ...ROW, provider: "azure" }]), { log });
    await store.start();
    expect(store.current().get("claude-new")).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    store.close();
  });

  it("refreshNow loads immediately", async () => {
    let rows: Record<string, unknown>[] = [];
    const store = new CatalogStore({ modelCatalogEntry: { findMany: async () => rows } }, { log: quiet });
    await store.start();
    rows = [ROW];
    await store.refreshNow();
    expect(store.current().get("claude-new")).toBeDefined();
    store.close();
  });
});

describe("currentModelCatalog", () => {
  it("is the shipped catalog until a store is installed, then the store's", async () => {
    expect(currentModelCatalog().get("claude-new")).toBeUndefined();
    const store = new CatalogStore(db([ROW]), { log: quiet });
    await store.start();
    installModelCatalog(store);
    expect(currentModelCatalog().get("claude-new")).toBeDefined();
    store.close();
  });
});

describe("refreshIntervalMs", () => {
  it("defaults to 45 s and reads WARDBY_MODEL_CATALOG_REFRESH_SECONDS", () => {
    expect(refreshIntervalMs({})).toBe(45_000);
    expect(refreshIntervalMs({ WARDBY_MODEL_CATALOG_REFRESH_SECONDS: "10" })).toBe(10_000);
  });
  it.each(["0", "-5", "abc", "1.5"])("rejects %s", (value) => {
    expect(() => refreshIntervalMs({ WARDBY_MODEL_CATALOG_REFRESH_SECONDS: value })).toThrow(
      /WARDBY_MODEL_CATALOG_REFRESH_SECONDS/,
    );
  });
});
