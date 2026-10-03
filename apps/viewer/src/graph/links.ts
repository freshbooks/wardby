import type { GraphRun, Outcome } from "../api/types";

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
      return null;
  }
}

/** The pull request or issue that started a run, if it can be opened. */
export function triggerLink(t: GraphRun["trigger"]): string | null {
  return t.kind === "code_host" ? githubLink(t.provider, t.repository, t.number) : null;
}
