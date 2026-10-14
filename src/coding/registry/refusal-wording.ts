/** Fixed operator guidance from structured registry codes, never registry free text. */
import type { RegistryRefusalSummary } from "./report.js";

const HELP = "[Help: package allowlist](https://github.com/wardby/wardby/blob/main/help/coding-packages.md)";
const ALLOWLIST = new Set(["wardby_package_not_allowed", "wardby_graph_incomplete", "wardby_graph_limit"]);

/** Untrusted names stay bounded code spans with mentions and markup defused. */
function codeSpan(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping untrusted control characters.
  const withoutControls = value.replace(/[`\u0000-\u001f\u007f<>]/g, " ");
  const safe = withoutControls.replace(/\s+/g, " ").replace(/@/g, "@​").slice(0, 120);
  return `\`${safe}\``;
}

export function packageRefusalWording(refusals: readonly RegistryRefusalSummary[], blocked = true): string {
  const distinct = [...new Map(refusals.map((r) => [JSON.stringify([r.ecosystem, r.name, r.reason]), r])).values()];
  const lines = distinct.slice(0, 10).map((r) => {
    const code = /^wardby_[a-z_]+$/.exec(r.reason)?.[0] === r.reason ? ` (\`${r.reason}\`)` : "";
    const guidance = ALLOWLIST.has(r.reason)
      ? "not on this agent's allowlist; add it to `codingProfile.packageAllowlist`"
      : r.reason === "wardby_version_filtered"
        ? "no version passed the release-age, advisory or malware checks; wait or adjust `packagePolicy.minReleaseAgeDays`, accept an advisory in `packagePolicy.acceptedAdvisories`, or upgrade. Never bypass malware checks"
        : "refused by the package registry; review the package policy and registry error before retrying";
    return `- ${codeSpan(r.ecosystem)} ${codeSpan(r.name)}: ${guidance}${code}`;
  });
  if (distinct.length > 10) lines.push(`- ${distinct.length - 10} more refused packages.`);
  return [
    blocked
      ? "⛔ **Blocked by the package registry: no changes were made.** Coding sub-runs couldn't install:"
      : "⚠️ **Dependency install incomplete.** Coding sub-runs couldn't install:",
    ...lines,
    "",
    "To unblock: use `update_agent` to update `codingProfile.packageAllowlist` or `codingProfile.packagePolicy` as appropriate (needs `packages:approve` or `agents:admin`), then mention `@wardby` again. " +
      HELP,
  ].join("\n");
}
