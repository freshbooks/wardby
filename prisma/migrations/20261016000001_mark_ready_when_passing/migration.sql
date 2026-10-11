-- Additive: opt-in to mark Wardby's draft pull requests ready once they pass, claimed once per pull request.
ALTER TABLE "AgentRepository" ADD COLUMN "markReadyWhenPassing" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CodingRun" ADD COLUMN "markedReadyAt" TIMESTAMP(3);
