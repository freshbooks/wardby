/**
 * Process wiring for workflow notifications: installs the outbox recorder
 * as the workflow-event sink and starts the lease-gated dispatcher. Safe in
 * every replica (the dispatcher elects one sender via SchedulerLease).
 * Without a configured chat provider this does nothing at all.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "#prisma";
import type { ChatProviderRegistry } from "../providers/chat/types.js";
import { logger } from "./logger.js";
import { startNotificationDispatcher } from "./notification-dispatcher.js";
import { createWorkflowEventRecorder } from "./workflow-event-recorder.js";
import { setWorkflowEventSink } from "./workflow-events.js";

const log = logger.child({ module: "notifications" });

export function installWorkflowEventRecorder(db: PrismaClient, chat: ChatProviderRegistry): void {
  const enabled = Object.keys(chat);
  if (enabled.length === 0) return;
  setWorkflowEventSink(createWorkflowEventRecorder(db, enabled));
}

export async function startNotifications(opts: {
  db: PrismaClient;
  chat: ChatProviderRegistry;
  holder?: string;
}): Promise<{ stop(): void }> {
  if (Object.keys(opts.chat).length === 0) return { stop() {} };
  installWorkflowEventRecorder(opts.db, opts.chat);
  for (const provider of Object.values(opts.chat)) {
    try {
      const who = await provider.authTest();
      log.info({ provider: provider.name, team: who.team, botUserId: who.botUserId }, "chat notifications acting as");
    } catch (err) {
      log.error(
        { err, provider: provider.name },
        "chat provider auth check failed; deliveries will pause until it succeeds",
      );
    }
  }
  return startNotificationDispatcher({ db: opts.db, chat: opts.chat, holder: opts.holder ?? `notify-${randomUUID()}` });
}
