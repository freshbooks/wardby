-- A review that published COMMENT while CI on its head was unfinished is
-- re-run once when CI finishes on that head.
ALTER TABLE "RunHostCheck" ADD COLUMN "ciPendingAtReview" BOOLEAN;
ALTER TABLE "RunHostCheck" ADD COLUMN "ciRereviewAt" TIMESTAMP(3);
