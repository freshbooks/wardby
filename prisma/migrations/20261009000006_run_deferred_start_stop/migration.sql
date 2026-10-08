-- Additive: runs dispatched (or asked to stop) by a process that holds no
-- executor -- the native sandbox gateway -- are started (or stopped) by the
-- scheduler leader through the server's executor.

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "startDeferredAt" TIMESTAMP(3),
ADD COLUMN "stopRequestedAt" TIMESTAMP(3),
ADD COLUMN "stopRequestReason" TEXT;

-- CreateIndex
CREATE INDEX "Run_startDeferredAt_idx" ON "Run"("startDeferredAt");

-- CreateIndex
CREATE INDEX "Run_stopRequestedAt_idx" ON "Run"("stopRequestedAt");
