-- Jira issue-tracker links and per-run status comments (phase 1).
CREATE TABLE "AgentIssueProject" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "triggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerStatuses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "jqlFilter" TEXT,
    "trustedAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "commentVisibilityRole" TEXT,
    "authorizedById" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentIssueProject_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentIssueProject_agentId_provider_projectKey_key" ON "AgentIssueProject"("agentId", "provider", "projectKey");
CREATE INDEX "AgentIssueProject_provider_projectKey_idx" ON "AgentIssueProject"("provider", "projectKey");
ALTER TABLE "AgentIssueProject" ADD CONSTRAINT "AgentIssueProject_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RunIssueStatus" (
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    "commentId" TEXT,
    "visibilityRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "RunIssueStatus_pkey" PRIMARY KEY ("runId")
);
CREATE INDEX "RunIssueStatus_completedAt_idx" ON "RunIssueStatus"("completedAt");
ALTER TABLE "RunIssueStatus" ADD CONSTRAINT "RunIssueStatus_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
