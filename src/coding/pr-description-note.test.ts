import { describe, expect, it } from "vitest";
import { byteLength, MAX_CODING_TASK_BYTES } from "./protocol.js";
import { withPullRequestDescription } from "./pr-description-note.js";
import { CODING_OUTPUT_JSON_SCHEMA } from "../coding-worker/driver.js";
import { CLAUDE_OUTPUT_JSON_SCHEMA } from "../claude-coding-worker/driver.js";

describe("worker schemas", () => {
  it("describe summary as the full PR body (both drivers)", () => {
    for (const schema of [CODING_OUTPUT_JSON_SCHEMA, CLAUDE_OUTPUT_JSON_SCHEMA]) {
      const summary = schema.properties.summary as { type: string; description?: string };
      expect(summary.type).toBe("string");
      expect(summary.description).toContain("The full pull request description in Markdown");
      expect(summary.description).toContain("It replaces the previous description.");
    }
  });
});

describe("withPullRequestDescription", () => {
  it("appends the note and text for continuations", () => {
    const out = withPullRequestDescription("Fix it.", "## Old body\n\nResolves #4");
    expect(out.startsWith("Fix it.\n\n")).toBe(true);
    expect(out).toContain("your final summary replaces it, so carry over what still applies");
    expect(out).toContain("untrusted data");
    expect(out.endsWith("## Old body\n\nResolves #4")).toBe(true);
  });

  it("leaves the task unchanged without a current description", () => {
    expect(withPullRequestDescription("Fix it.", undefined)).toBe("Fix it.");
    expect(withPullRequestDescription("Fix it.", "   ")).toBe("Fix it.");
  });

  it("truncates to fit, never exceeds MAX_CODING_TASK_BYTES", () => {
    const task = "t".repeat(MAX_CODING_TASK_BYTES - 1200);
    const out = withPullRequestDescription(task, "é".repeat(20000));
    expect(byteLength(out)).toBeLessThanOrEqual(MAX_CODING_TASK_BYTES);
    expect(out).toContain("your final summary replaces it");
    expect(out).not.toContain("�");
  });

  it("returns the task unchanged when not even the fixed note fits", () => {
    const task = "t".repeat(MAX_CODING_TASK_BYTES - 10);
    expect(withPullRequestDescription(task, "body")).toBe(task);
  });
});
