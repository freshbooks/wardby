-- Jira phase 2: per-link allowlists for transitions and field edits.
ALTER TABLE "AgentIssueProject" ADD COLUMN "allowedTransitions" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AgentIssueProject" ADD COLUMN "writableFields" TEXT[] DEFAULT ARRAY[]::TEXT[];
