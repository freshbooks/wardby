/**
 * Minimal Jira Cloud REST client. Holds the credential; callers pass paths.
 * One retry on 429 honouring Retry-After (capped), per Atlassian's
 * rate-limiting guidance. Response bodies are never logged.
 */
import type { JiraConfig } from "../../config/providers.js";
import { IssueTrackerError } from "./types.js";

const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RequestOptions {
  /** Accept an empty 2xx body as `undefined` (void writes). */
  allowEmpty?: boolean;
  /** Per-attempt timeout; default 30 s. */
  timeoutMs?: number;
  /** Retry once on 429 honouring Retry-After; default true. */
  retryOn429?: boolean;
}

export class JiraClient {
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * Always sent explicitly: undici's default `Accept-Language: *` makes Jira answer in the site's default
   * language rather than the account's own, which breaks matching of status and link type names.
   */
  private language = "en-US";

  constructor(
    private readonly cfg: Pick<JiraConfig, "apiBaseUrl" | "auth">,
    opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.authorization = `Bearer ${cfg.auth.token}`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  setLanguage(tag: string): void {
    this.language = tag;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.cfg.apiBaseUrl}${path}`, {
          method,
          headers: {
            authorization: this.authorization,
            accept: "application/json",
            "accept-language": this.language,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch {
        throw new IssueTrackerError("tracker_api_error", "Jira could not be reached.");
      }
      if (res.status === 429 && attempt === 0 && opts.retryOn429 !== false) {
        const seconds = Number(res.headers.get("retry-after"));
        await this.sleep(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000, MAX_RETRY_AFTER_MS));
        continue;
      }
      if (res.status === 204) return undefined as T;
      if (!res.ok) throw statusError(res.status);
      try {
        // Void writes (issue links, property writes) may succeed with an empty body; JSON callers may not.
        const text = await res.text();
        if (text === "" && opts.allowEmpty) return undefined as T;
        return JSON.parse(text) as T;
      } catch {
        throw new IssueTrackerError("tracker_invalid_response", "Jira returned a response that was not JSON.");
      }
    }
  }

  /**
   * GET returning at most `maxBytes` of the raw body (attachment content). Sends `Range` and caps
   * client-side too, in case the server ignores it. Redirects are never followed with the credential:
   * a 3xx is followed only to an https Atlassian host and without Authorization.
   */
  async requestBytes(path: string, opts: { maxBytes: number; timeoutMs?: number }): Promise<Uint8Array> {
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: "*/*",
      "accept-language": this.language,
      range: `bytes=0-${Math.max(opts.maxBytes, 1) - 1}`,
    };
    let url = `${this.cfg.apiBaseUrl}${path}`;
    let res: Response | undefined;
    let retried = false;
    try {
      for (let hops = 0; hops <= 3;) {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (res.status === 429 && !retried) {
          retried = true;
          const seconds = Number(res.headers.get("retry-after"));
          await this.sleep(
            Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000, MAX_RETRY_AFTER_MS),
          );
          continue;
        }
        if (res.status < 300 || res.status >= 400) break;
        hops++;
        let next: URL;
        try {
          next = new URL(res.headers.get("location") ?? "", url);
        } catch {
          throw new IssueTrackerError("tracker_invalid_response", "Jira returned an unusable download redirect.");
        }
        if (next.protocol !== "https:" || !isAtlassianHost(next.hostname))
          throw new IssueTrackerError("tracker_invalid_response", "Jira redirected the download somewhere unexpected.");
        url = next.toString();
        // A pre-signed media URL: the Jira credential never goes to it.
        delete headers.authorization;
      }
    } catch (err) {
      if (err instanceof IssueTrackerError) throw err;
      throw new IssueTrackerError("tracker_api_error", "Jira could not be reached.");
    }
    if (!res || (res.status >= 300 && res.status < 400))
      throw new IssueTrackerError("tracker_api_error", "Jira's download redirected too many times.");
    if (!res.ok) throw statusError(res.status);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
      while (reader && total < opts.maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = value.subarray(0, opts.maxBytes - total);
        chunks.push(piece);
        total += piece.length;
        if (piece.length < value.length) await reader.cancel();
      }
      if (reader && total >= opts.maxBytes) await reader.cancel().catch(() => undefined);
    } catch {
      throw new IssueTrackerError("tracker_api_error", "Jira's download was interrupted.");
    }
    return Buffer.concat(chunks);
  }
}

/** Hosts a download redirect may point at (Atlassian media). */
const isAtlassianHost = (h: string): boolean => /(^|\.)(atlassian\.com|atlassian\.net|atl-paas\.net)$/.test(h);

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
