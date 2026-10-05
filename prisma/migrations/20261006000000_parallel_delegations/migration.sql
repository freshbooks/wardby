-- Parallel delegations (docs/agent-recipes.md): a native lead's delegate_to_*
-- calls made in one model turn run at the same time. Additive: every existing
-- agent keeps running its delegations one after another.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "parallelDelegations" BOOLEAN NOT NULL DEFAULT false;
