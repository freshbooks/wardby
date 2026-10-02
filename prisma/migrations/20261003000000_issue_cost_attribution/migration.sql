-- Issue cost attribution (Jira phase 4a): work items, per-run attribution,
-- and per-run per-model usage by priced token kind.

CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT,
    "type" TEXT,
    "url" TEXT,
    "scopeKey" TEXT NOT NULL,
    "parentKey" TEXT,
    "parentKind" TEXT,
    "refreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkItem_provider_key_key" ON "WorkItem"("provider", "key");
CREATE INDEX "WorkItem_provider_parentKey_idx" ON "WorkItem"("provider", "parentKey");
CREATE INDEX "WorkItem_provider_scopeKey_idx" ON "WorkItem"("provider", "scopeKey");

CREATE TABLE "RunAttribution" (
    "runId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "parentKeyAtRun" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunAttribution_pkey" PRIMARY KEY ("runId")
);

CREATE INDEX "RunAttribution_workItemId_idx" ON "RunAttribution"("workItemId");
CREATE INDEX "RunAttribution_parentKeyAtRun_idx" ON "RunAttribution"("parentKeyAtRun");

ALTER TABLE "RunAttribution" ADD CONSTRAINT "RunAttribution_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunAttribution" ADD CONSTRAINT "RunAttribution_workItemId_fkey"
    FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RunModelUsage" (
    "runId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "freshInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(18,10) NOT NULL DEFAULT 0,

    CONSTRAINT "RunModelUsage_pkey" PRIMARY KEY ("runId", "model")
);

ALTER TABLE "RunModelUsage" ADD CONSTRAINT "RunModelUsage_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
