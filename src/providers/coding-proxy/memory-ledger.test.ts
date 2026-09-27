import { describe, expect, it } from "vitest";
import { MemoryProxyLedger } from "./memory-ledger.js";

describe("MemoryProxyLedger upstream failures", () => {
  it("keeps only the first upstream failure code of a session", async () => {
    const ledger = new MemoryProxyLedger();
    await ledger.createSession({
      id: "s1",
      runId: "r1",
      capabilityHash: "hash",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["m"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
      registryTokenHash: "registry-hash",
    });
    expect(await ledger.upstreamFailure("s1")).toBeNull();
    expect((await ledger.findSessionByCapabilityHash("hash"))?.upstreamFailure ?? null).toBeNull();
    await ledger.recordUpstreamFailure("s1", "project_spend_limit_exceeded");
    await ledger.recordUpstreamFailure("s1", "server_error");
    expect(await ledger.upstreamFailure("s1")).toBe("project_spend_limit_exceeded");
    expect((await ledger.findSessionByCapabilityHash("hash"))?.upstreamFailure).toBe("project_spend_limit_exceeded");
    await ledger.recordUpstreamFailure("missing", "server_error");
    expect(await ledger.upstreamFailure("missing")).toBeNull();
  });
});
