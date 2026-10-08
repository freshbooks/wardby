-- Additive: the native sandbox gateway's session and call ledger. A session
-- authenticates a sandbox worker by capability hash and pins what its run
-- loaded; calls reserve and settle model spend and keep replayable results.

-- CreateEnum
CREATE TYPE "NativeGatewaySessionStatus" AS ENUM ('active', 'finished', 'cancelled');

-- CreateEnum
CREATE TYPE "NativeGatewayCallStatus" AS ENUM ('reserved', 'completed', 'released', 'uncertain', 'pending', 'waiting_budget');

-- CreateTable
CREATE TABLE "NativeGatewaySession" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "capabilityHash" TEXT NOT NULL,
    "status" "NativeGatewaySessionStatus" NOT NULL DEFAULT 'active',
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "budgetUsd" DECIMAL(18,10) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "budgetExhaustedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeGatewaySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeGatewayCall" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "NativeGatewayCallStatus" NOT NULL,
    "reservationUsd" DECIMAL(18,10),
    "actualCostUsd" DECIMAL(18,10),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "result" JSONB,
    "childRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "NativeGatewayCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeGatewaySession_runId_key" ON "NativeGatewaySession"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "NativeGatewaySession_capabilityHash_key" ON "NativeGatewaySession"("capabilityHash");

-- CreateIndex
CREATE INDEX "NativeGatewayCall_sessionId_status_idx" ON "NativeGatewayCall"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NativeGatewayCall_sessionId_callId_key" ON "NativeGatewayCall"("sessionId", "callId");

-- AddForeignKey
ALTER TABLE "NativeGatewaySession" ADD CONSTRAINT "NativeGatewaySession_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeGatewayCall" ADD CONSTRAINT "NativeGatewayCall_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NativeGatewaySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
