-- Additive: manual reviews of local repositories. A LocalPullRequest is a
-- branch compared against a base in a local: repository, keyed by a durable
-- serial number so the repo_* review tools address it like a pull request;
-- LocalReview holds what review agents publish on it.

-- CreateTable
CREATE TABLE "LocalPullRequest" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "repository" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalPullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalReview" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "comments" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LocalPullRequest_number_key" ON "LocalPullRequest"("number");

-- CreateIndex
CREATE UNIQUE INDEX "LocalPullRequest_runId_key" ON "LocalPullRequest"("runId");

-- CreateIndex
CREATE INDEX "LocalPullRequest_repository_branch_idx" ON "LocalPullRequest"("repository", "branch");

-- CreateIndex
CREATE INDEX "LocalReview_pullRequestId_createdAt_idx" ON "LocalReview"("pullRequestId", "createdAt");

-- AddForeignKey
ALTER TABLE "LocalPullRequest" ADD CONSTRAINT "LocalPullRequest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalReview" ADD CONSTRAINT "LocalReview_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "LocalPullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
