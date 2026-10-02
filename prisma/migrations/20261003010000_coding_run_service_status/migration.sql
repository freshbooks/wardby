-- Live start-up state of each coding-run service, one row per run x service,
-- written by the job launchers for display (wardby viewer, get_run).
CREATE TYPE "CodingServiceState" AS ENUM ('pending', 'probing', 'ready', 'failed');

CREATE TABLE "CodingRunServiceStatus" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" "CodingServiceState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER,
    "reason" TEXT,
    "readyAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodingRunServiceStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodingRunServiceStatus_runId_name_key" ON "CodingRunServiceStatus"("runId", "name");

ALTER TABLE "CodingRunServiceStatus" ADD CONSTRAINT "CodingRunServiceStatus_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
