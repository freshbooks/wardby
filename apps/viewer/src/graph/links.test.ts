import { describe, expect, it } from "vitest";
import { outcomeLink, triggerLink } from "./links";

describe("links", () => {
  it("uses a pull request's own https URL", () => {
    expect(
      outcomeLink({
        kind: "pull_request",
        provider: "github",
        repository: "o/r",
        number: 7,
        url: "https://x.test/7",
        state: null,
      }),
    ).toBe("https://x.test/7");
  });

  it("falls back to GitHub for a pull request whose URL is not https", () => {
    expect(
      outcomeLink({
        kind: "pull_request",
        provider: "github",
        repository: "o/r",
        number: 7,
        url: "javascript:x",
        state: null,
      }),
    ).toBe("https://github.com/o/r/issues/7");
  });

  it("links checks, comments and review triggers on GitHub only", () => {
    expect(outcomeLink({ kind: "check", provider: "github", repository: "o/r", number: 9, completed: true })).toBe(
      "https://github.com/o/r/issues/9",
    );
    expect(
      outcomeLink({ kind: "check", provider: "github", repository: "o/r", number: null, completed: true }),
    ).toBeNull();
    expect(outcomeLink({ kind: "issue_comment", provider: "jira", issueKey: "K-1" })).toBeNull();
    expect(triggerLink({ kind: "code_host", provider: "github", repository: "o/r", number: 3, event: "mention" })).toBe(
      "https://github.com/o/r/issues/3",
    );
    expect(triggerLink({ kind: "manual" })).toBeNull();
  });

  it("refuses a repository name that is not owner/name", () => {
    expect(
      triggerLink({ kind: "code_host", provider: "github", repository: "o/r/../x", number: 3, event: "review" }),
    ).toBeNull();
  });
});
