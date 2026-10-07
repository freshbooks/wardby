import { loadGitHubUserAuthConfig, loadGitHubVcsConfig } from "../../config/providers.js";
import { loadLocalRepoRoots } from "../../coding/local-repo.js";
import { GitHubAppClient } from "../vcs/github.js";
import { GitHubReviewHost } from "./github.js";
import { GitHubUserAuthorizer } from "./github-user-auth.js";
import { LocalReviewHost, type LocalReviewHostOptions } from "./local.js";
import type { HostUserAuthorizerRegistry, ReviewHostRegistry } from "./types.js";

export * from "./types.js";
export { GitHubReviewHost } from "./github.js";
export { GitHubUserAuthorizer } from "./github-user-auth.js";
export { LocalReviewHost } from "./local.js";

function githubClient(env: NodeJS.ProcessEnv): GitHubAppClient | null {
  const github = loadGitHubVcsConfig(env);
  if (!github.appId || !github.privateKey) return null;
  return new GitHubAppClient({ appId: github.appId, privateKey: github.privateKey, apiVersion: github.apiVersion });
}

/**
 * One host per configured provider: github when a GitHub App is configured,
 * local when LOCAL_REPO_ROOTS names at least one existing root (the roots are
 * re-read on every local call). Empty = the repo_* tools are never offered.
 */
export function buildReviewHosts(env: NodeJS.ProcessEnv, db: LocalReviewHostOptions["db"]): ReviewHostRegistry {
  const hosts: ReviewHostRegistry = {};
  const client = githubClient(env);
  if (client) hosts.github = new GitHubReviewHost(client);
  if (loadLocalRepoRoots(env).roots.length > 0) {
    hosts.local = new LocalReviewHost({ db, roots: () => loadLocalRepoRoots(env).roots });
  }
  return hosts;
}

/**
 * One identity-linking flow per provider whose App has OAuth client
 * credentials (GITHUB_APP_CLIENT_ID/SECRET). Empty = link_host_account is
 * disabled; repository authorization is enforced either way.
 */
export function buildHostUserAuthorizers(env: NodeJS.ProcessEnv = process.env): HostUserAuthorizerRegistry {
  const client = githubClient(env);
  const { clientId, clientSecret } = loadGitHubUserAuthConfig(env);
  if (!client || !clientId || !clientSecret) return {};
  return { github: new GitHubUserAuthorizer({ client, clientId, clientSecret }) };
}
