-- Additive: per-agent native execution mode (control-plane or sandbox) and the
-- per-run snapshot the executor routes on. Existing agents default to
-- control-plane; existing runs keep a null snapshot (legacy = control plane).

-- CreateEnum
CREATE TYPE "NativeExecutionMode" AS ENUM ('control-plane', 'sandbox');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "nativeExecutionMode" "NativeExecutionMode" NOT NULL DEFAULT 'control-plane';

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "nativeExecutionMode" "NativeExecutionMode";
