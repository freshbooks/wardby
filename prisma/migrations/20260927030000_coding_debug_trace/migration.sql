-- Admin-requested debug trace for coding runs: the profile carries an expiry,
-- and each run records at dispatch whether it was traced.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "debugTraceUntil" TIMESTAMP(3);
ALTER TABLE "CodingRun" ADD COLUMN "debugTrace" BOOLEAN NOT NULL DEFAULT false;
