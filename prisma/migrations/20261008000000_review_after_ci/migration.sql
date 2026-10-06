-- Additive: a repository link can hold its review until that head's own CI
-- finishes (AgentRepository.waitForCi), and DeferredReview records a review
-- held that way until the ci_completed event or the reconciler's fallback
-- sweep starts it.

-- AlterTable
ALTER TABLE "AgentRepository" ADD COLUMN "waitForCi" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DeferredReview" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "checkName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeferredReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeferredReview_provider_repository_prNumber_headSha_agentId_key" ON "DeferredReview"("provider", "repository", "prNumber", "headSha", "agentId");

-- CreateIndex
CREATE INDEX "DeferredReview_provider_repository_headSha_idx" ON "DeferredReview"("provider", "repository", "headSha");

-- CreateIndex
CREATE INDEX "DeferredReview_createdAt_idx" ON "DeferredReview"("createdAt");

-- AddForeignKey
ALTER TABLE "DeferredReview" ADD CONSTRAINT "DeferredReview_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
