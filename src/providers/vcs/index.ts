import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { GitHubVcsConfig, ProviderConfig } from "../../config/providers.js";
import { GitHubAppClient } from "./github.js";
import { GitVcsProvider } from "./git.js";
import { loadLocalRepoRoots } from "../../coding/local-repo.js";
import { GitHubRemote } from "./github-remote.js";
import { LocalRemote } from "./local-remote.js";
import { RoutingVcsProvider } from "./routing.js";
import type { VcsProvider } from "./types.js";

export * from "./types.js";
export { GitHubAppClient } from "./github.js";
export { GitVcsProvider, NodeGitCommandRunner } from "./git.js";
export { GitHubRemote } from "./github-remote.js";
export { LocalRemote } from "./local-remote.js";
export { RoutingVcsProvider } from "./routing.js";
export type { GitRemote, PublishInput, PublishResult } from "./remote.js";

/**
 * GitHub is built only with App credentials, local repositories only with
 * LOCAL_REPO_ROOTS; neither being set is allowed and surfaces when a
 * repository of the missing kind is used (see RoutingVcsProvider).
 */
export function buildVcsProvider(
  providerConfig: Pick<ProviderConfig, "vcs">,
  config: GitHubVcsConfig,
  env: NodeJS.ProcessEnv = process.env,
): VcsProvider {
  if (providerConfig.vcs !== "github") throw new Error(`VCS_PROVIDER=${String(providerConfig.vcs)} is not supported.`);
  const rootDir = resolve(config.workRoot ?? resolve(tmpdir(), "wardby-vcs"));
  const limits = { maxChangedFiles: config.maxChangedFiles, maxDiffBytes: config.maxDiffBytes };
  let github: VcsProvider | null = null;
  if (config.appId && config.privateKey) {
    const client = new GitHubAppClient({
      appId: config.appId,
      privateKey: config.privateKey,
      apiVersion: config.apiVersion,
    });
    github = new GitVcsProvider({ rootDir, remote: new GitHubRemote({ github: client }), ...limits });
  }
  let local: VcsProvider | null = null;
  if (loadLocalRepoRoots(env).roots.length > 0) {
    // Re-read per call so a root that disappears (or appears) takes effect without a restart.
    local = new GitVcsProvider({
      rootDir,
      remote: new LocalRemote({ roots: () => loadLocalRepoRoots(env).roots }),
      ...limits,
    });
  }
  return new RoutingVcsProvider({ github, local });
}
