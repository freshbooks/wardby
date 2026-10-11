-- Additive: the blocking advisories a run's packagePolicy.acceptedAdvisories
-- waived for a version its lockfile plan approved (empty when none).
ALTER TABLE "RegistryApprovedVersion" ADD COLUMN "acceptedAdvisories" TEXT[] DEFAULT ARRAY[]::TEXT[];
