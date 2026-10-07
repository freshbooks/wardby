import { pathToFileURL } from "node:url";
import {
  LOCAL_REPO_PREFIX,
  LocalRepoError,
  normalizeLocalRepository,
  resolveLocalRepository,
} from "../../coding/local-repo.js";
import type { GitRemote, PublishInput, PublishResult } from "./remote.js";

/** The only refs a local remote ever writes into the user's repository. */
const LOCAL_PUSH_REF = /^wardby\/run-[A-Za-z0-9_-]+$/;

export interface LocalRemoteOptions {
  /** Trusted roots (realpaths), re-read on every call so a change takes effect without a restart. */
  roots: () => readonly string[];
}

/**
 * A git repository on the control plane's own disk (`local:/abs/path`).
 *
 * The source repository is touched only by `ls-remote`, the clone's
 * upload-pack, and a push to `refs/heads/wardby/run-*`: the clone goes through
 * a `file://` URL (so `--depth 1` is honored and nothing is hard-linked), never
 * reads the source's working tree, and every hardening check in GitVcsProvider
 * still applies. `protocol.file.allow=always` is set only on this remote's
 * clone/ls-remote/push invocations; HARDENED_GIT_CONFIG's `protocol.allow=never`
 * keeps every other transport off.
 */
export class LocalRemote implements GitRemote {
  readonly gitConfig: readonly string[] = ["-c", "protocol.file.allow=always"];

  constructor(private readonly options: LocalRemoteOptions) {}

  normalizeRepository(repository: string): string {
    return normalizeLocalRepository(repository);
  }

  /** The repository must already be named by its realpath (withAccess verifies it against the roots). */
  cloneUrl(repository: string): string {
    return pathToFileURL(normalizeLocalRepository(repository).slice(LOCAL_REPO_PREFIX.length)).href;
  }

  async withAccess<T>(repository: string, fn: (token: string | undefined) => Promise<T>): Promise<T> {
    const requested = normalizeLocalRepository(repository);
    const resolved = await resolveLocalRepository(requested, this.options.roots());
    // cloneUrl is built from the requested path, so it must be the path that
    // was just checked: a symlinked or otherwise non-canonical name is refused.
    if (resolved.repository !== requested) {
      throw new LocalRepoError("local_repo_not_allowed", "repository must be named by its real path");
    }
    return fn(undefined);
  }

  /** No pull request to check: a continuation's branch must exist, which prepare's ls-remote pre-check enforces. */
  async assertContinuationOpen(): Promise<void> {}

  async publish({ workspace }: PublishInput): Promise<PublishResult> {
    this.assertPushRef(workspace.headRef);
    return { kind: "branch", branch: workspace.headRef };
  }

  conflictError(): Error {
    return new LocalRepoError(
      "local_branch_conflict",
      "the branch moved in the local repository since the run started",
    );
  }

  refNotFoundError(ref: string): Error {
    return new LocalRepoError("local_ref_not_found", `branch ${ref} does not exist in the local repository`);
  }

  assertPushRef(headRef: string): void {
    if (!LOCAL_PUSH_REF.test(headRef)) throw new Error("vcs_head_ref_invalid");
  }
}
