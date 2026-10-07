-- Additive: a coding run on a local repository pushes a branch instead of
-- opening a pull request, so CodingRun records that branch (resultBranch) and
-- the commit the run started from (baseSha, recorded for every outcome).

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN "resultBranch" TEXT,
ADD COLUMN "baseSha" TEXT;
