/**
 * What repo_pr_read tells a reviewer about CI. The note is deterministic and
 * written here, not by the host, so every reviewer prompt gets the same rule:
 * CI on the head commit is authoritative about build and tests; the
 * description's Tests come from Wardby's sandbox, which may have had an
 * incomplete install.
 */
import { FAILING_CONCLUSIONS } from "../providers/review-host/ci.js";
import type { CiView, PullRequestView } from "../providers/review-host/types.js";
import { DEPENDENCY_INSTALL_INCOMPLETE } from "../providers/vcs/github.js";

export interface AgentCiView extends CiView {
  /** The description carries Wardby's Dependency install incomplete warning. Description text: informational only. */
  sandboxInstallIncomplete: boolean;
  note: string;
}

const MAX_NAMED = 10;

function named(ci: CiView, pick: (c: CiView["checks"][number]) => boolean): string {
  const names = ci.checks.filter(pick).map((c) => c.name);
  const shown = names.slice(0, MAX_NAMED).join(", ");
  return names.length > MAX_NAMED ? `${shown} and ${names.length - MAX_NAMED} more` : shown;
}

export function ciNote(ci: CiView, sandboxInstallIncomplete: boolean): string {
  const n = ci.checks.length;
  const plural = `${n} check${n === 1 ? "" : "s"}`;
  const sandbox = sandboxInstallIncomplete
    ? ` The description's ${DEPENDENCY_INSTALL_INCOMPLETE.replace(/\.$/, "")} warning means Wardby's sandbox could not install every package, so a failure under its Tests is not evidence against this change.`
    : "";
  const statuses =
    ci.statusesUnavailable && ci.state !== "unavailable"
      ? " Commit statuses could not be read (often because the App lacks Commit statuses: Read), so only check runs are listed."
      : "";
  let main: string;
  switch (ci.state) {
    case "passing":
      main = `CI passed on this head (${plural}). The description's Tests were run in Wardby's sandbox; where they disagree with CI, CI is authoritative.`;
      break;
    case "failing":
      main = `CI failed on this head: ${named(ci, (c) => c.status === "completed" && FAILING_CONCLUSIONS.has(c.conclusion ?? ""))}. Base build and test findings on these checks, not on the description's Tests.`;
      break;
    case "pending":
      main = `CI is still running on this head (${named(ci, (c) => c.status !== "completed")}). These results are not final: say they were pending; do not report them as passed or failed, and do not use the description's Tests in their place.`;
      break;
    case "inconclusive":
      main = `CI finished without a clear result on this head (${plural}; some were cancelled, stale, or skipped). Do not report the change as failing CI.`;
      break;
    case "none":
      main = "No CI checks or statuses are reported on this head: CI may not be configured, or has not started yet.";
      break;
    case "unavailable":
      main = `CI results could not be read (${ci.unavailableReason ?? "unknown"}). Do not infer CI results from the description.`;
      break;
  }
  return `${main}${statuses}${sandbox}`;
}

export function ciForAgent(view: Pick<PullRequestView, "headSha" | "body" | "ci">): AgentCiView {
  const ci: CiView = view.ci ?? {
    headSha: view.headSha,
    state: "unavailable",
    checks: [],
    truncated: false,
    statusesUnavailable: true,
    unavailableReason: "host_unsupported",
  };
  const sandboxInstallIncomplete = (view.body ?? "").includes(`**${DEPENDENCY_INSTALL_INCOMPLETE}**`);
  return { ...ci, sandboxInstallIncomplete, note: ciNote(ci, sandboxInstallIncomplete) };
}
