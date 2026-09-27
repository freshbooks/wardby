-- Record the first upstream failure code the coding proxy relays for a
-- session, so the run can be reported as refused by the model provider.
ALTER TABLE "CodingProxySession" ADD COLUMN "upstreamFailure" TEXT;
