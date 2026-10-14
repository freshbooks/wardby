/**
 * Shared wording for package refusals served by the registry proxy. Pure (no provider imports) so the
 * proxy, the run report, and the PR banner all read one table.
 */

export const PACKAGE_NOT_ALLOWED = "wardby_package_not_allowed";
export const PACKAGE_NOT_ALLOWED_PENDING = "wardby_package_not_allowed_pending";
export const GRAPH_LIMIT = "wardby_graph_limit";
export const GRAPH_INCOMPLETE = "wardby_graph_incomplete";

export interface WalkProgress {
  walked: number;
  queued: number;
}

function packages(count: number): string {
  return `${count.toLocaleString("en-US")} package${count === 1 ? "" : "s"}`;
}

export function notAllowedMessage(name: string, ecosystem: string, hasAllowlist: boolean): string {
  const why = hasAllowlist
    ? `${name} (${ecosystem}) is not on this agent's allowlist, and is not reachable from an allowlisted package`
    : `${name} (${ecosystem}) is not allowed: this agent has no allowlist for ${ecosystem}`;
  return `${why}. The agent's owner must allowlist it; retrying will not help.`;
}

export function notAllowedPendingMessage(name: string, ecosystem: string, progress: WalkProgress): string {
  return (
    `${name} (${ecosystem}) was not found among the allowlisted packages' dependencies after ` +
    `${packages(progress.walked)}, at least ${progress.queued.toLocaleString("en-US")} more queued. ` +
    `It may still be reachable, but the walk was cut short; retrying rarely helps. ` +
    `The agent's owner must allowlist ${name} directly.`
  );
}

export function graphLimitMessage(name: string, ecosystem: string, limit: number): string {
  return (
    `Resolving ${name} (${ecosystem}) needs more than ${packages(limit)}, the REGISTRY_MAX_GRAPH_PACKAGES limit; ` +
    `retrying will not help. The agent's owner must allowlist the packages directly or raise the limit.`
  );
}

export function graphIncompleteMessage(name: string, ecosystem: string, progress: WalkProgress): string {
  return (
    `The dependencies of ${name} (${ecosystem}) could not be fully checked after ${packages(progress.walked)}, ` +
    `${progress.queued.toLocaleString("en-US")} still queued (usually a transient registry problem). Please try again.`
  );
}

const OWNER = "The agent's owner must allowlist the package; retrying will not help.";

const HINTS: Record<string, string> = {
  [PACKAGE_NOT_ALLOWED]: `The package is not on the agent's allowlist and not reachable from it. ${OWNER}`,
  [PACKAGE_NOT_ALLOWED_PENDING]: `The dependency walk ended before reaching the package. Retrying rarely helps. ${OWNER}`,
  [GRAPH_LIMIT]: `Resolving the package exceeds REGISTRY_MAX_GRAPH_PACKAGES. ${OWNER}`,
  [GRAPH_INCOMPLETE]: "The dependencies could not be fully checked, usually a transient problem. Try again.",
};

/** What each refusal code means to someone reading the PR, without the registry's internals. */
const MEANINGS: Record<string, string> = {
  [PACKAGE_NOT_ALLOWED]:
    "not on the allowlist, or only reachable through a refused package; the owner must allowlist it",
  [PACKAGE_NOT_ALLOWED_PENDING]: "not reached before the dependency walk stopped; the owner must allowlist it",
  [GRAPH_LIMIT]: "its dependency graph is over the package limit; the owner must allowlist it directly",
  [GRAPH_INCOMPLETE]: "its dependencies could not be confirmed (usually transient)",
  wardby_version_filtered: "withheld: newer than the release-age limit, or a high-severity advisory",
  wardby_lockfile_integrity_mismatch: "the lock file's integrity does not match the registry's",
  wardby_upstream_error: "the upstream registry failed (transient)",
  wardby_audit_unavailable: "the advisory check was unavailable (transient)",
};

/** Static guidance for a stored refusal code (get_run `hint`); undefined for unknown codes. */
export function refusalHint(code: string): string | undefined {
  return Object.hasOwn(HINTS, code) ? HINTS[code] : undefined;
}

/** Short parenthetical for the PR banner; undefined for unknown codes. */
export function refusalMeaning(code: string): string | undefined {
  return Object.hasOwn(MEANINGS, code) ? MEANINGS[code] : undefined;
}
