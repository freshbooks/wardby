import type { GraphRun, Outcome } from "../api/types";

export function triggerLabel(trigger: GraphRun["trigger"]): string {
  switch (trigger.kind) {
    case "scheduled":
      return `⏰ ${trigger.schedule ?? "scheduled"}`;
    case "webhook":
      return "webhook";
    case "manual":
      return "manual";
    case "issue":
      return `◆ ${trigger.provider} ${trigger.issueKey}`;
    case "code_host":
      return `⎇ ${trigger.repository}${trigger.number === null ? "" : `#${trigger.number}`} ${trigger.event}`;
    case "host_event":
      return "host event";
    case "subagent":
      return "sub-agent";
  }
}

/** Searchable text of an outcome: its repository or issue key. */
export function outcomeTerms(o: Outcome): string[] {
  return "repository" in o ? [o.repository] : [o.issueKey];
}
