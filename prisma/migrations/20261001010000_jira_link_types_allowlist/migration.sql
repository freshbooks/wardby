-- Jira phase 2: per-link allowlist of issue link types jira_link_issues may create.
ALTER TABLE "AgentIssueProject" ADD COLUMN "allowedLinkTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];
