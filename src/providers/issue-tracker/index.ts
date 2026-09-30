import { loadJiraConfig } from "../../config/providers.js";
import { JiraClient } from "./jira-client.js";
import { JiraIssueTracker } from "./jira.js";
import type { IssueTrackerRegistry } from "./types.js";

export * from "./types.js";
export { JiraIssueTracker, agentFooter } from "./jira.js";

/** One tracker per configured provider; empty when Jira isn't configured (the jira_* tools are then never offered). */
export function buildIssueTrackers(env: NodeJS.ProcessEnv = process.env): IssueTrackerRegistry {
  const jira = loadJiraConfig(env);
  return jira ? { jira: new JiraIssueTracker(new JiraClient(jira), jira.siteUrl) } : {};
}
