import type { GraphRun, Outcome } from "../api/types";

/** The server's link for an issue or comment (Jira), when it has one: https only. */
function httpsOnly(url: string | null | undefined): string | null {
  return url && url.startsWith("https://") ? url : null;
}

/** A GitHub issue URL also opens a pull request with that number (GitHub redirects). */
function githubLink(provider: string, repository: string, number: number | null): string | null {
  if (provider !== "github" || number === null || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
  return `https://github.com/${repository}/issues/${number}`;
}

/** Where an outcome lives on the code host, if it can be opened; https only. */
export function outcomeLink(o: Outcome): string | null {
  switch (o.kind) {
    case "pull_request":
      return o.url.startsWith("https://") ? o.url : githubLink(o.provider, o.repository, o.number);
    case "code_host_comment":
    case "check":
      return githubLink(o.provider, o.repository, o.number);
    case "issue_comment":
      return httpsOnly(o.url);
  }
}

/** The pull request or issue that started a run, if it can be opened. */
export function triggerLink(t: GraphRun["trigger"]): string | null {
  if (t.kind === "code_host") return githubLink(t.provider, t.repository, t.number);
  if (t.kind === "issue") return httpsOnly(t.url);
  return null;
}
