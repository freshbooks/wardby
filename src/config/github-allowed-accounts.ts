/**
 * Which GitHub accounts this server serves through its GitHub App: the App's
 * owner, always, plus WARDBY_GITHUB_ALLOWED_ACCOUNTS. Fail closed — there is no
 * wildcard. Events from other accounts are ignored, their installations
 * removed, and their repositories refused.
 */
export const GITHUB_ACCOUNT_NOT_ALLOWED = "github_account_not_allowed";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function isGitHubLogin(value: unknown): value is string {
  return typeof value === "string" && LOGIN.test(value);
}

export function parseGitHubAllowedAccounts(raw: string | undefined): ReadonlySet<string> {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const entry of entries) {
    if (!LOGIN.test(entry)) throw new Error(`WARDBY_GITHUB_ALLOWED_ACCOUNTS: "${entry}" is not a GitHub login.`);
  }
  return new Set(entries.map((entry) => entry.toLowerCase()));
}

export function loadGitHubAllowedAccounts(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return parseGitHubAllowedAccounts(env.WARDBY_GITHUB_ALLOWED_ACCOUNTS);
}

/** The App's owner plus the configured accounts, lower-cased. */
export function trustedAccounts(ownerLogin: string, extra: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([ownerLogin.toLowerCase(), ...extra]);
}

/** The owner of an `owner/name` GitHub repository, lower-cased. */
export function githubAccountOf(repository: string): string {
  return repository.split("/", 1)[0].toLowerCase();
}

export function isGitHubAccountAllowed(trusted: ReadonlySet<string>, login: string): boolean {
  return trusted.has(login.toLowerCase());
}
