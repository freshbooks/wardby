-- Configurable per-run debug-trace cap: the profile carries the admin-set cap
-- (MiB), and each traced run records at dispatch the cap it used.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "debugTraceMaxMb" INTEGER;
ALTER TABLE "CodingRun" ADD COLUMN "debugTraceMaxMb" INTEGER;
