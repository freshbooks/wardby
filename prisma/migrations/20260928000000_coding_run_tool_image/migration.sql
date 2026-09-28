-- Claude Code's tool-runner image (the container that runs its commands) for the
-- agent's toolchain, resolved at dispatch alongside workerImage so a run keeps the
-- image it was dispatched with. Additive and nullable: existing rows and Codex runs
-- leave it null, and the launcher falls back to the deployment's default image.
ALTER TABLE "CodingRun" ADD COLUMN "toolImage" TEXT;
