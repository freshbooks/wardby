import { describe, expect, it, vi } from "vitest";
import { recordNativeModelUsage } from "./model-usage.js";

describe("recordNativeModelUsage", () => {
  it("sets one row for the run's model by priced token kind", async () => {
    const upsert = vi.fn(async () => ({}));
    await recordNativeModelUsage({ runModelUsage: { upsert } } as never, "run-1", "claude-sonnet-4-6", {
      tokensIn: 1000,
      tokensOut: 50,
      costUsd: 0.0123,
      cachedInputTokens: 800,
      cacheWriteTokens: 100,
    });
    const values = {
      freshInputTokens: 200,
      cachedInputTokens: 800,
      cacheWriteTokens: 100,
      outputTokens: 50,
      costUsd: 0.0123,
    };
    expect(upsert).toHaveBeenCalledWith({
      where: { runId_model: { runId: "run-1", model: "claude-sonnet-4-6" } },
      create: { runId: "run-1", model: "claude-sonnet-4-6", ...values },
      update: values,
    });
  });

  it("treats missing cache fields as zero", async () => {
    const upsert = vi.fn(async (_args: unknown) => ({}));
    await recordNativeModelUsage({ runModelUsage: { upsert } } as never, "r", "gpt-5", {
      tokensIn: 10,
      tokensOut: 1,
      costUsd: 0,
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      create: { freshInputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("skips a run that used nothing, and never throws", async () => {
    const upsert = vi.fn(async () => {
      throw new Error("db down");
    });
    await recordNativeModelUsage({ runModelUsage: { upsert } } as never, "r", "m", {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
    expect(upsert).not.toHaveBeenCalled();
    await expect(
      recordNativeModelUsage({ runModelUsage: { upsert } } as never, "r", "m", {
        tokensIn: 1,
        tokensOut: 0,
        costUsd: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
