-- Jira phase 3 (the Jira -> code bridge): per-link PR statuses, the originating
-- issue on a coding run, and the pull requests opened for tracker issues.
ALTER TABLE "AgentIssueProject" ADD COLUMN "onPullRequestOpened" TEXT;
ALTER TABLE "AgentIssueProject" ADD COLUMN "onPullRequestMerged" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "issueProvider" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "issueKey" TEXT;

-- No foreign keys by design: audit-style rows that survive agent/run deletion.
CREATE TABLE "IssuePullRequest" (
    "id" TEXT NOT NULL,
    "issueProvider" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    "codeProvider" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "openedByRunId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssuePullRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IssuePullRequest_codeProvider_repository_number_issueProvid_key" ON "IssuePullRequest"("codeProvider", "repository", "number", "issueProvider", "issueKey");

CREATE INDEX "IssuePullRequest_issueProvider_issueKey_idx" ON "IssuePullRequest"("issueProvider", "issueKey");
