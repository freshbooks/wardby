-- Jira phase 4: issue creation allowlist + cap on the link, self-defect config on the agent, and dedupe fingerprints.
ALTER TABLE "AgentIssueProject" ADD COLUMN "creatableIssueTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AgentIssueProject" ADD COLUMN "maxNewIssuesPerRun" INTEGER;

ALTER TABLE "Agent" ADD COLUMN "defectProjectKey" TEXT;
ALTER TABLE "Agent" ADD COLUMN "defectIssueType" TEXT;

CREATE TABLE "IssueFingerprint" (
    "id" TEXT NOT NULL,
    "issueProvider" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdByRunId" TEXT,
    "seenCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueFingerprint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IssueFingerprint_issueProvider_issueKey_key" ON "IssueFingerprint"("issueProvider", "issueKey");
CREATE INDEX "IssueFingerprint_issueProvider_projectKey_fingerprintHash_idx" ON "IssueFingerprint"("issueProvider", "projectKey", "fingerprintHash");
CREATE INDEX "IssueFingerprint_createdByRunId_idx" ON "IssueFingerprint"("createdByRunId");
