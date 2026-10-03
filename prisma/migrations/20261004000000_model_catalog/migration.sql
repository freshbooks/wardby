-- Model catalog: admin overrides of the shipped catalog, and each run's
-- catalog entry as recorded when it started. Additive only.
CREATE TABLE "ModelCatalogEntry" (
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "encoding" TEXT NOT NULL,
    "inputPerMTok" DOUBLE PRECISION NOT NULL,
    "outputPerMTok" DOUBLE PRECISION NOT NULL,
    "cachedInputPerMTok" DOUBLE PRECISION NOT NULL,
    "cacheWritePerMTok" DOUBLE PRECISION NOT NULL,
    "efforts" TEXT[],
    "thinkingMode" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelCatalogEntry_pkey" PRIMARY KEY ("provider","modelId")
);

ALTER TABLE "Run" ADD COLUMN "pricingVersion" TEXT;
ALTER TABLE "Run" ADD COLUMN "pricingSnapshot" JSONB;

ALTER TABLE "CodingProxySession" ADD COLUMN "pricingVersion" TEXT;
ALTER TABLE "CodingProxySession" ADD COLUMN "catalogEntry" JSONB;
