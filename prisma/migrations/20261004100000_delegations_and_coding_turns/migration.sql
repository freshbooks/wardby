-- Sub-agent fan-out and Claude Code turn limits (docs/agent-recipes.md, docs/coding-agent-setup.md).
-- Additive: two new columns. Every existing agent keeps one delegation per run;
-- every existing coding profile and run keeps the worker's default turn limit.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "maxDelegationsPerRun" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN "maxTurns" INTEGER;

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN "maxTurns" INTEGER;
