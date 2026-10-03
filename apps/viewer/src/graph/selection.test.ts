import { describe, expect, it } from "vitest";
import { selectionForNode } from "./selection";

describe("selectionForNode", () => {
  it("maps run, trigger and outcome nodes to their run", () => {
    expect(selectionForNode("r:abc")).toEqual({ runId: "abc", focus: null });
    expect(selectionForNode("t:abc")).toEqual({ runId: "abc", focus: { kind: "trigger" } });
    expect(selectionForNode("o:abc:2")).toEqual({ runId: "abc", focus: { kind: "outcome", index: 2 } });
  });

  it("rejects anything else", () => {
    for (const id of ["x:abc", "r:", "o:abc", "o:abc:-1", "o:abc:x", ""]) expect(selectionForNode(id)).toBeNull();
  });
});
