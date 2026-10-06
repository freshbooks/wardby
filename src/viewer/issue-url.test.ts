import { describe, expect, it } from "vitest";
import { issueUrl } from "./graph.js";

describe("issueUrl", () => {
  const sites = { jira: "https://your-site.atlassian.net" };

  it("links a Jira issue, and a comment on it", () => {
    expect(issueUrl(sites, "jira", "SCRUM-15")).toBe("https://your-site.atlassian.net/browse/SCRUM-15");
    expect(issueUrl(sites, "jira", "SCRUM-15", "10042")).toBe(
      "https://your-site.atlassian.net/browse/SCRUM-15?focusedCommentId=10042",
    );
  });

  it("is null without a configured site or for other trackers", () => {
    expect(issueUrl({}, "jira", "SCRUM-15")).toBeNull();
    expect(issueUrl({ linear: "https://linear.app/x" }, "linear", "ENG-1")).toBeNull();
  });

  it("encodes keys and comment ids", () => {
    expect(issueUrl(sites, "jira", "A B", "1&x=2")).toBe(
      "https://your-site.atlassian.net/browse/A%20B?focusedCommentId=1%26x%3D2",
    );
  });
});
