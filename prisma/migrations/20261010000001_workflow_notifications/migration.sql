-- Workflow notifications (Slack): channel links, the event outbox, per-channel
-- deliveries, and thread parents. Additive only.

CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelName" TEXT,
    "issueProvider" TEXT,
    "projectKey" TEXT,
    "agentId" TEXT,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "includeCost" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "authorizedById" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NotificationChannel_one_subject" CHECK (
        ("agentId" IS NOT NULL AND "issueProvider" IS NULL AND "projectKey" IS NULL)
        OR ("agentId" IS NULL AND "issueProvider" IS NOT NULL AND "projectKey" IS NOT NULL)
    )
);

-- Name truncated the way Prisma does for PostgreSQL's 63-byte identifier limit,
-- so `migrate diff` sees it as the @@unique([provider, channelId, issueProvider, projectKey]).
-- The one-subject CHECK above has no schema.prisma equivalent; migrate diff ignores it.
CREATE UNIQUE INDEX "NotificationChannel_provider_channelId_issueProvider_projec_key"
    ON "NotificationChannel"("provider", "channelId", "issueProvider", "projectKey");
CREATE UNIQUE INDEX "NotificationChannel_provider_channelId_agentId_key"
    ON "NotificationChannel"("provider", "channelId", "agentId");
CREATE INDEX "NotificationChannel_issueProvider_projectKey_idx"
    ON "NotificationChannel"("issueProvider", "projectKey");
CREATE INDEX "NotificationChannel_agentId_idx" ON "NotificationChannel"("agentId");

ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkflowEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "runId" TEXT,
    "agentId" TEXT,
    "workItemProvider" TEXT,
    "workItemKey" TEXT,
    "codeProvider" TEXT,
    "repository" TEXT,
    "prNumber" INTEGER,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowEvent_dedupeKey_key" ON "WorkflowEvent"("dedupeKey");
CREATE INDEX "WorkflowEvent_createdAt_idx" ON "WorkflowEvent"("createdAt");

CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "includeCost" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "messageTs" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDelivery_eventId_provider_channelId_key"
    ON "NotificationDelivery"("eventId", "provider", "channelId");
CREATE INDEX "NotificationDelivery_state_nextAttemptAt_idx"
    ON "NotificationDelivery"("state", "nextAttemptAt");
CREATE INDEX "NotificationDelivery_provider_channelId_threadKey_createdAt_idx"
    ON "NotificationDelivery"("provider", "channelId", "threadKey", "createdAt");

ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "WorkflowEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "NotificationThread" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "parentTs" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationThread_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationThread_provider_channelId_threadKey_key"
    ON "NotificationThread"("provider", "channelId", "threadKey");
