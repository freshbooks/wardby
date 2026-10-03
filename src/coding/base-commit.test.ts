import { describe, expect, it } from "vitest";
import { MAX_CODING_TASK_BYTES } from "./protocol.js";
import { withBaseCommit } from "./base-commit.js";

const SHA = "db6e4fa032e52c80670a86918faead2c7fe790bc";

describe("withBaseCommit", () => {
  it("appends the base commit line after the task", () => {
    expect(withBaseCommit("Fix the bug.", SHA)).toBe(
      `Fix the bug.\n\nBase commit: ${SHA} (the commit this workspace was checked out at; the workspace has no git metadata).`,
    );
  });
  it("leaves the task unchanged when the sha is not a full commit", () => {
    expect(withBaseCommit("Fix the bug.", "abc")).toBe("Fix the bug.");
  });
  it("leaves the task unchanged when the line would exceed the task limit", () => {
    const task = "t".repeat(MAX_CODING_TASK_BYTES - 10);
    expect(withBaseCommit(task, SHA)).toBe(task);
  });
});
