/**
 * Minimal Jira Cloud REST client. Holds the credential; callers pass paths.
 * One retry on 429 honouring Retry-After (capped), per Atlassian's
 * rate-limiting guidance. Response bodies are never logged.
 */
import type { JiraConfig } from "../../config/providers.js";
import { IssueTrackerError } from "./types.js";

const MAX_RETRY_AFTER_MS = 10_000;

export class JiraClient {
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cfg: Pick<JiraConfig, "apiBaseUrl" | "auth">,
    opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.authorization =
      cfg.auth.kind === "basic"
        ? `Basic ${Buffer.from(`${cfg.auth.email}:${cfg.auth.token}`).toString("base64")}`
        : `Bearer ${cfg.auth.token}`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.cfg.apiBaseUrl}${path}`, {
          method,
          headers: {
            authorization: this.authorization,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new IssueTrackerError("tracker_api_error", "Jira could not be reached.");
      }
      if (res.status === 429 && attempt === 0) {
        const seconds = Number(res.headers.get("retry-after"));
        await this.sleep(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000, MAX_RETRY_AFTER_MS));
        continue;
      }
      if (res.status === 204) return undefined as T;
      if (!res.ok) throw statusError(res.status);
      try {
        return (await res.json()) as T;
      } catch {
        throw new IssueTrackerError("tracker_invalid_response", "Jira returned a response that was not JSON.");
      }
    }
  }
}

function statusError(status: number): IssueTrackerError {
  if (status === 404)
    return new IssueTrackerError("tracker_not_found", "Not found in Jira (or not visible to wardby's Jira account).");
  if (status === 401 || status === 403)
    return new IssueTrackerError("tracker_permission_denied", "wardby's Jira account is not allowed to do that.");
  if (status === 429)
    return new IssueTrackerError("tracker_rate_limited", "Jira is rate-limiting wardby; try again shortly.");
  if (status === 400) return new IssueTrackerError("tracker_invalid_request", "Jira rejected the request as invalid.");
  return new IssueTrackerError("tracker_api_error", `Jira returned HTTP ${status}.`);
}
