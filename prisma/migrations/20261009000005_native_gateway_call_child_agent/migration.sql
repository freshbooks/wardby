-- Additive: a delegation's sub-agent on its gateway call row, so a delegation
-- waiting for budget holds its place in the per-run delegation limit.

-- AlterTable
ALTER TABLE "NativeGatewayCall" ADD COLUMN "childAgentId" TEXT;
