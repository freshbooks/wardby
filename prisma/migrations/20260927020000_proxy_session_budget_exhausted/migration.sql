-- Record the first time the coding proxy refuses a session's request for
-- budget, so the run can be reported as out of budget rather than failed.
ALTER TABLE "CodingProxySession" ADD COLUMN "budgetExhaustedAt" TIMESTAMP(3);
