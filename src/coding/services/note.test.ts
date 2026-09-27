import { describe, expect, it } from "vitest";
import { servicesInstructionNote } from "./note.js";

describe("servicesInstructionNote", () => {
  it("says nothing for a run without services", () => {
    expect(servicesInstructionNote([])).toBeUndefined();
  });

  it("lists each service and its variables, says they start empty and where they are", () => {
    const note = servicesInstructionNote([
      {
        name: "postgres",
        version: "16",
        testEnv: { DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test", PGHOST: "127.0.0.1" },
      },
      { name: "redis", version: "7", testEnv: {} },
    ]);
    expect(note).toBe(
      [
        "Services for this run: wardby started these next to your workspace, reachable on 127.0.0.1. Each one starts empty; create any schema or data your tests need.",
        "- postgres 16: DATABASE_URL=postgres://test:test@127.0.0.1:5432/test, PGHOST=127.0.0.1",
        "- redis 7",
        "These variables are already set in your shell environment; tests should read them instead of hard-coding connection details. Where two services set the same variable, the one listed first wins.",
      ].join("\n"),
    );
  });
});
