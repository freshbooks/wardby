import { afterEach, describe, expect, it, vi } from "vitest";
import { emitWorkflowEvent, setWorkflowEventSink } from "./workflow-events.js";

const input = { dedupeKey: "k", payload: { kind: "issue_picked_up", agentName: "a", trigger: "t" } } as const;

describe("emitWorkflowEvent", () => {
  afterEach(() => setWorkflowEventSink(null));
  it("is a no-op without a sink", async () => {
    await expect(emitWorkflowEvent(input)).resolves.toBeUndefined();
  });
  it("passes the input to the sink", async () => {
    const sink = vi.fn(async () => {});
    setWorkflowEventSink(sink);
    await emitWorkflowEvent(input);
    expect(sink).toHaveBeenCalledWith(input);
  });
  it("swallows sink failures", async () => {
    setWorkflowEventSink(async () => {
      throw new Error("db down");
    });
    await expect(emitWorkflowEvent(input)).resolves.toBeUndefined();
  });
});
