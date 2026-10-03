import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogStore,
  currentModelCatalog,
  installModelCatalog,
  refreshIntervalMs,
  startModelCatalog,
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
  quiet.warn.mockClear();
  quiet.info.mockClear();
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
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "models.catalog.row_invalid" }),
      expect.any(String),
    );
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

  it("refreshNow rejects and leaves the current catalog unchanged when the load fails", async () => {
    let shouldFail = false;
    const findMany = vi.fn(async () => {
      if (shouldFail) throw new Error("boom");
      return [ROW];
    });
    const store = new CatalogStore({ modelCatalogEntry: { findMany } }, { log: quiet });
    await store.start();
    await store.refreshNow();
    const before = store.current();
    expect(before.get("claude-new")).toBeDefined();
    shouldFail = true;
    await expect(store.refreshNow()).rejects.toThrow(/boom/);
    expect(store.current()).toBe(before);
    store.close();
  });

  it("calling start() twice does not leak a timer", async () => {
    vi.useFakeTimers();
    const store = new CatalogStore(db([]), { intervalMs: 1000, log: quiet });
    await store.start();
    await store.start();
    expect(vi.getTimerCount()).toBe(1);
    store.close();
  });

  it("never lets a poll result that started before refreshNow replace refreshNow's newer result", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((rows: Record<string, unknown>[]) => void) | undefined;
    let calls = 0;
    const findMany = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve([]); // the initial load in start()
      if (calls === 2) {
        // the poll tick: held open until released below
        return new Promise<Record<string, unknown>[]>((resolve) => {
          resolvePoll = resolve;
        });
      }
      // refreshNow's call: resolves immediately, ahead of the still-pending poll
      return Promise.resolve([{ ...ROW, modelId: "claude-newer" }]);
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    const store = new CatalogStore({ modelCatalogEntry: { findMany } }, { intervalMs: 1000, log });
    await store.start();
    await vi.advanceTimersByTimeAsync(1000); // fires the poll tick; its findMany() call hangs open
    await store.refreshNow();
    expect(store.current().get("claude-newer")).toBeDefined();
    resolvePoll?.([{ ...ROW, modelId: "claude-older" }]);
    await vi.advanceTimersByTimeAsync(0); // let the now-resolved poll settle
    expect(store.current().get("claude-newer")).toBeDefined();
    expect(store.current().get("claude-older")).toBeUndefined();
    store.close();
  });

  it("close() while a poll is in flight: the poll's late failure neither logs nor changes current()", async () => {
    vi.useFakeTimers();
    let rejectPoll: ((err: Error) => void) | undefined;
    let calls = 0;
    const findMany = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve([]); // the initial load in start()
      // the poll tick: held open until released below
      return new Promise<Record<string, unknown>[]>((_resolve, reject) => {
        rejectPoll = reject;
      });
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    const store = new CatalogStore({ modelCatalogEntry: { findMany } }, { intervalMs: 1000, log });
    await store.start();
    await vi.advanceTimersByTimeAsync(1000); // fires the poll tick; its findMany() call hangs open
    const before = store.current();
    store.close();
    rejectPoll?.(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0); // let the now-rejected poll settle
    expect(store.current()).toBe(before);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("startModelCatalog", () => {
  it("loads, installs, and fails without a database", async () => {
    const store = await startModelCatalog(db([ROW]), { log: quiet });
    expect(currentModelCatalog().get("claude-new")).toBeDefined();
    store.close();
    await expect(startModelCatalog(db(new Error("down")), { log: quiet })).rejects.toThrow(/model catalog/);
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
