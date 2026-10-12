-- Additive: the run dependency cache. An agent flag snapshotted onto each
-- coding run, the run's reported cache result, the proxy session's approved
-- lock hashes and seal, and the snapshot metadata the coding proxy keeps.
-- A snapshot outlives the run that created it: createdByRunId is cleared, not
-- cascaded, when that run is deleted.

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN "dependencyCache" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN "dependencyCache" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "dependencyCacheResult" JSONB;

-- AlterTable
ALTER TABLE "CodingProxySession" ADD COLUMN "dependencyCacheLockHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "dependencyCacheSealedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DependencySnapshot" (
    "id" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "projectPath" TEXT NOT NULL DEFAULT '.',
    "lockHash" TEXT NOT NULL,
    "workerImage" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "blobKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByRunId" TEXT,

    CONSTRAINT "DependencySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DependencySnapshot_blobKey_key" ON "DependencySnapshot"("blobKey");

-- CreateIndex
CREATE UNIQUE INDEX "DependencySnapshot_ecosystem_repository_projectPath_lockHas_key" ON "DependencySnapshot"("ecosystem", "repository", "projectPath", "lockHash", "workerImage", "policyHash");

-- CreateIndex
CREATE INDEX "DependencySnapshot_ecosystem_repository_projectPath_workerI_idx" ON "DependencySnapshot"("ecosystem", "repository", "projectPath", "workerImage", "policyHash", "createdAt");

-- CreateIndex
CREATE INDEX "DependencySnapshot_lastUsedAt_idx" ON "DependencySnapshot"("lastUsedAt");

-- CreateIndex
CREATE INDEX "DependencySnapshot_createdByRunId_projectPath_idx" ON "DependencySnapshot"("createdByRunId", "projectPath");

-- AddForeignKey
ALTER TABLE "DependencySnapshot" ADD CONSTRAINT "DependencySnapshot_createdByRunId_fkey" FOREIGN KEY ("createdByRunId") REFERENCES "CodingRun"("runId") ON DELETE SET NULL ON UPDATE CASCADE;
