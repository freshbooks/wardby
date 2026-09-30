/**
 * Jira Cloud webhook ingress — framework-agnostic, mounted unauthenticated
 * (by OAuth) in streamable-http.ts at /hosts/jira/events. Authenticated by the
 * webhook secret (X-Hub-Signature, WebSub style) over the raw body. The
 * delivery id (X-Atlassian-Webhook-Identifier) is stable across Jira's
 * retries, so it is the dedupe key. Nothing from the body is logged.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { maybePruneHostEventDeliveries } from "./deliveries.js";
import { routeIssueEvent, type IssueEventDb } from "../../core/issue-events.js";
import { logger } from "../../core/logger.js";
import type { Executor } from "../../providers/executor/types.js";
import { normalizeJiraEvent, verifyJiraSignature } from "../../providers/issue-tracker/jira-events.js";
import type { IssueTrackerRegistry } from "../../providers/issue-tracker/types.js";

const log = logger.child({ module: "jira-ingress" });
const SAFE_DELIVERY = /^[A-Za-z0-9._:-]{1,200}$/;

export interface JiraIngressDeps {
  db: IssueEventDb & Pick<PrismaClient, "hostEventDelivery">;
  executor: Executor;
  trackers: IssueTrackerRegistry;
  webhookSecret: string;
}

export interface JiraIngressResult {
  status: number;
  body: Record<string, unknown>;
  /** Cosmetic follow-ups to run after the response is sent. */
  afterResponse?: () => Promise<void>;
}

export async function handleJiraEventIngress(
  req: { headers: Record<string, string | undefined>; rawBody: string },
  deps: JiraIngressDeps,
): Promise<JiraIngressResult> {
  const tracker = deps.trackers.jira;
  if (!tracker) return { status: 404, body: { error: "not_found" } };
  if (!verifyJiraSignature(req.rawBody, req.headers["x-hub-signature"], deps.webhookSecret)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }
  // wardby must not act as a person. A lookup failure throws (5xx), so Jira retries the delivery.
  const identity = await tracker.identity();
  if (identity.accountType === "atlassian") {
    log.error("Jira token belongs to a person; refusing deliveries (use a service account)");
    return { status: 503, body: { error: "jira_personal_account" } };
  }
  const deliveryId = req.headers["x-atlassian-webhook-identifier"];
  if (!deliveryId || !SAFE_DELIVERY.test(deliveryId)) {
    return { status: 400, body: { error: "missing_delivery_headers" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const event = normalizeJiraEvent(payload, identity.accountId);
  // An event we don't act on must never claim the delivery id (see the GitHub ingress).
  if (!event) return { status: 202, body: { ignored: true } };

  try {
    await deps.db.hostEventDelivery.create({ data: { provider: "jira", deliveryId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { status: 202, body: { duplicate: true } };
    }
    throw err;
  }
  await maybePruneHostEventDeliveries(deps.db, new Date());

  // A routing failure must not leave the delivery permanently marked done:
  // un-record it and rethrow so Jira's retry is routed for real.
  try {
    const routed = await routeIssueEvent(event, { db: deps.db, executor: deps.executor, trackers: deps.trackers });
    log.info({ kinds: event.kinds, deliveryId, runIds: routed.runIds }, "jira event routed");
    return {
      status: 202,
      body: { runIds: routed.runIds },
      afterResponse: async () => {
        for (const followUp of routed.followUps) await followUp();
      },
    };
  } catch (err) {
    await deps.db.hostEventDelivery
      .deleteMany({ where: { provider: "jira", deliveryId } })
      .catch((delErr: unknown) =>
        log.warn({ err: delErr }, "could not roll back the delivery record after a routing failure"),
      );
    throw err;
  }
}
