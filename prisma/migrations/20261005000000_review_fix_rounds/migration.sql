-- Automatic review fix rounds: a per-link round cap, and the verdict and
-- review text a reviewer run published on its own check.
ALTER TABLE "AgentRepository" ADD COLUMN "reviewFixMaxRounds" INTEGER;
ALTER TABLE "RunHostCheck" ADD COLUMN "verdict" TEXT;
ALTER TABLE "RunHostCheck" ADD COLUMN "reviewBody" TEXT;
