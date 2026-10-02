/**
 * Self-defects: when a run of an opted-in agent (Agent.defectProjectKey +
 * defectIssueType) ends failed, lost or budget_exhausted, the control plane
 * (no model involved) files a defect for it through fileIssue, deduped by a
 * structural fingerprint so a recurring failure becomes "seen again" comments
 * on one issue rather than a new issue per run.
 *
 *   fingerprint  self:<agentId>:<status>:<category>
 *   category     CodingRun.failureCategory, else the leading `code:` token of
 *                Run.error, else "unknown" — never the error's free text
 *
 * Fails closed: the agent needs a live write link to defectProjectKey whose
 * creatableIssueTypes includes defectIssueType; otherwise it logs and skips.
 * Self-defects are not counted against the link's maxNewIssuesPerRun: that cap
 * bounds what a run's model may create, while this is a control-plane action
 * whose volume the fingerprint dedupe already bounds (one open issue per
 * agent/status/category).
 *
 * Best effort and never throws. No recursion: this is only ever called after a
 * run's row is final, outside any run, and a failure to file only logs — it
 * never fails a run, so it can never trigger another filing.
 */
import type { PrismaClient } from "#prisma";
import { agentFooter } from "../providers/issue-tracker/jira.js";
import {
  ISSUE_TRACKER_PROVIDERS,
  type IssueTracker,
  type IssueTrackerRegistry,
} from "../providers/issue-tracker/types.js";
import { fileIssue, type FileIssueInput, type FileIssueResult } from "./issue-dedupe.js";
import { propertyKey } from "./issue-tracker-tools.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "self-defects" });

/** Run statuses that file a defect; succeeded, cancelled and refused never do. */
export const SELF_DEFECT_STATUSES: ReadonlySet<string> = new Set(["failed", "lost", "budget_exhausted"]);
/** How long a caller waits for the filing; past this it carries on in the background (and still only logs). */
export const SELF_DEFECT_WAIT_MS = 15_000;
const SUMMARY_MAX_LENGTH = 255;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export type SelfDefectDb = Pick<PrismaClient, "agent" | "agentIssueProject" | "codingRun" | "$transaction">;

/** The finished run, as its final row has it. */
export interface SelfDefectRun {
  id: string;
  agentId: string;
  status: string;
  error: string | null;
  finishedAt: Date | null;
}

export interface SelfDefectOptions {
  /** Injected for tests; defaults to issue-dedupe's fileIssue on `db`. */
  fileIssue?: (input: FileIssueInput) => Promise<FileIssueResult>;
  waitMs?: number;
}

/** The leading `code:` token of a run error (lower-cased), or "unknown". Never any of the free text after it. */
export function errorClass(error: string | null | undefined): string {
  const match = /^([A-Za-z][A-Za-z0-9_.-]{0,63}):/.exec(error ?? "");
  return match ? match[1].toLowerCase() : "unknown";
}

export function selfDefectFingerprint(agentId: string, status: string, category: string): string {
  return `self:${agentId}:${status}:${category}`;
}

function safeCategory(value: string | null | undefined): string | null {
  const lowered = value?.trim().toLowerCase();
  return lowered && CATEGORY_PATTERN.test(lowered) ? lowered : null;
}

/**
 * Files (or re-sights) the defect for a finished run. Resolves to the filing's
 * result, or null when nothing was filed (not a filing status, not opted in,
 * no live link, an error, or still in flight after `waitMs`). Never throws.
 */
export async function fileSelfDefect(
  db: SelfDefectDb,
  trackers: IssueTrackerRegistry | undefined,
  run: SelfDefectRun,
  opts: SelfDefectOptions = {},
): Promise<FileIssueResult | null> {
  if (!SELF_DEFECT_STATUSES.has(run.status) || !trackers) return null;
  const filing = attempt(db, trackers, run, opts).catch((err: unknown) => {
    log.warn({ err, runId: run.id, agentId: run.agentId }, "could not file the run's self-defect");
    return null;
  });
  const waitMs = opts.waitMs ?? SELF_DEFECT_WAIT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log.warn({ runId: run.id, waitMs }, "self-defect filing still in progress; no longer waiting for it");
      resolve(null);
    }, waitMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([filing, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function attempt(
  db: SelfDefectDb,
  trackers: IssueTrackerRegistry,
  run: SelfDefectRun,
  opts: SelfDefectOptions,
): Promise<FileIssueResult | null> {
  const configured = ISSUE_TRACKER_PROVIDERS.filter((p) => trackers[p]);
  if (configured.length === 0) return null;
  const agent = await db.agent.findUnique({
    where: { id: run.agentId },
    select: { id: true, name: true, defectProjectKey: true, defectIssueType: true },
  });
  if (!agent?.defectProjectKey || !agent.defectIssueType) return null;
  const projectKey = agent.defectProjectKey;
  const issueType = agent.defectIssueType;

  let tracker: IssueTracker | undefined;
  let link: { provider: string; projectKey: string; access: string; commentVisibilityRole: string | null } | undefined;
  for (const provider of configured) {
    // Live, read now: an unlink, downgrade or allowlist change since the run started applies here.
    const row = await db.agentIssueProject.findUnique({
      where: { agentId_provider_projectKey: { agentId: agent.id, provider, projectKey } },
      select: {
        provider: true,
        projectKey: true,
        access: true,
        commentVisibilityRole: true,
        creatableIssueTypes: true,
      },
    });
    if (!row) continue;
    const typeAllowed = row.creatableIssueTypes.some((t) => t.trim().toLowerCase() === issueType.trim().toLowerCase());
    if (row.access !== "write" || !typeAllowed) {
      log.warn(
        { runId: run.id, agentId: agent.id, projectKey, access: row.access, typeAllowed },
        "self-defects skipped: the agent's link to the defect project is not writable or does not allow the issue type",
      );
      return null;
    }
    tracker = trackers[provider];
    link = row;
    break;
  }
  if (!tracker || !link) {
    log.warn({ runId: run.id, agentId: agent.id, projectKey }, "self-defects skipped: no link to the defect project");
    return null;
  }

  let codingCategory: string | null = null;
  try {
    const coding = await db.codingRun.findUnique({ where: { runId: run.id }, select: { failureCategory: true } });
    codingCategory = safeCategory(coding?.failureCategory);
  } catch (err) {
    log.debug({ err, runId: run.id }, "no coding failure category for the self-defect");
  }
  const category = codingCategory ?? errorClass(run.error);
  const finished = (run.finishedAt ?? new Date()).toISOString();
  const summary = `wardby agent "${agent.name}": ${run.status}${category === "unknown" ? "" : ` (${category})`}`;
  const description = [
    `A run of wardby agent "${agent.name}" ended ${run.status}.`,
    "",
    `- Run: ${run.id}`,
    `- Agent: ${agent.id}`,
    `- Status: ${run.status}`,
    `- Failure category: ${category}`,
    `- Finished: ${finished}`,
    "",
    "Filed by wardby itself. The run's error text is not included; see the run in wardby for details.",
    "",
    agentFooter(agent.id),
  ].join("\n");

  const file = opts.fileIssue ?? ((input: FileIssueInput) => fileIssue({ db }, input));
  // Not subject to maxNewIssuesPerRun (control plane; dedupe bounds volume), so createAllowed stays at its default.
  const result = await file({
    agentId: agent.id,
    runId: run.id,
    link,
    tracker,
    fingerprint: selfDefectFingerprint(agent.id, run.status, category),
    create: {
      issueType,
      summary: summary.length > SUMMARY_MAX_LENGTH ? `${summary.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : summary,
      descriptionMarkdown: description,
      properties: { [propertyKey(agent.id, "self-defect")]: { runId: run.id } },
    },
    seenAgainMarkdown: `Run ${run.id} ended ${run.status} at ${finished}.\n\n${agentFooter(agent.id)}`,
  });
  if ("error" in result) {
    log.warn({ runId: run.id, agentId: agent.id, error: result.error }, "self-defect filing failed");
  } else {
    log.info(
      { runId: run.id, agentId: agent.id, outcome: result.outcome, issueKey: result.issueKey },
      "self-defect filed",
    );
  }
  return result;
}
