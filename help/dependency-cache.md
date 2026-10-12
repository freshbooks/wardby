---
id: dependency-cache
title: Dependency cache for coding runs
summary: Restore npm node_modules from a verified snapshot before a coding agent starts, so runs skip the install.
audience: operator
tags: [coding-agents, packages, npm, node_modules, dependency-cache, cache, npm-ci, lockfile, snapshot, restore, blob-store, workspaces, tool_unavailable, sha_mismatch, unsafe_archive, dependencyCache]
appliesTo: >=0.6.1
---

# Dependency cache for coding runs

With the dependency cache on, a coding run's `node_modules` is prepared
**before the agent starts** from a snapshot in a blob store, so the agent
doesn't spend minutes on `npm ci`. It covers npm only. Off by default.

## How it behaves

For each eligible project the run reports one result in `get_run`
(`dependencyCache.projects[]`):

- `hit`: a snapshot for this exact lockfile was restored; nothing was
  installed.
- `nearest`: a snapshot for an older lockfile of the same repository and folder
  was restored, then updated to the committed lockfile.
- `cold`: no snapshot, so `npm ci` ran and the result was stored.
- `skipped` or `refused`: nothing was prepared and the agent installs for
  itself. A skip never fails the run; its `reason` says why.

The agent's task says dependencies are pre-installed and not to run `npm ci`
there (it would delete the prepared tree); `npm install <package>` is fine.
A pull request gets a "Dependency cache: restored `node_modules` for ..." line
for folders restored from a snapshot.

## Why it is safe

- Snapshots are built only by Wardby, before the agent starts. Then the upload
  window is sealed; the agent can't read or write the cache.
- A restore happens only after the coding proxy re-approves the committed
  lockfile under the agent's current allowlist, release age and advisory
  policy. A policy that now refuses a package means no restore.
- Keys come from the server, not the worker. Downloads are checked against a
  recorded SHA-256 and size, the archive is scanned and the tree compared with
  the lockfile before use, and a damaged snapshot is deleted and rebuilt.
- Install scripts are not cached. Snapshots are built with `--ignore-scripts`;
  `npm rebuild` runs after the seal, only when needed, with a minimal
  environment.

## When it applies

- npm with `package-lock.json` `lockfileVersion` 2 or 3, at the repository root
  and/or up to 4 projects up to 3 folders deep.
- Ignored: `node_modules`, dot-folders, symlinks, folders that already have a
  `node_modules`, and npm workspaces monorepos (root and members are skipped).
- The agent needs a package allowlist, and the worker (or Claude Code
  tool-runner) image must come from a release that includes the cache.

## Turn it on

1. On the coding proxy: `WARDBY_DEPENDENCY_CACHE=true` plus a blob store
   (`BLOB_STORE=gcs|s3|local` and its bucket or directory variables). GKE:
   `dependency_cache_enabled` and `dependency_cache_bucket_name` in Terraform,
   then `WARDBY_DEPENDENCY_CACHE=true deploy/gke/up.sh`. AWS: the same Terraform
   variables, plus the `BLOB_STORE_S3_*` proxy variables. kind:
   `WARDBY_DEPENDENCY_CACHE=true bash deploy/kind-coding/up.sh` (not durable).
   Docker quickstart: add `WARDBY_DEPENDENCY_CACHE=true` to `.wardby/.env`
   (requires wardby 0.6.1 or later).
2. GKE: re-run `bootstrap-database-iam.sh` before deploying so the proxy can
   use the `DependencySnapshot` table.
3. Per agent: `update_agent` with `codingProfile.dependencyCache: true`. This
   needs `packages:approve` or `agents:admin`.

Tuning, on the proxy: `WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB` (1024),
`_REPO_CAP_MB` (4096), `_TOTAL_CAP_MB` (20480), `_MAX_AGE_DAYS` (14, counted
from creation, so snapshots are rebuilt periodically) and `_UPLOAD_SECONDS`
(900). On GKE and AWS keep the Terraform `dependency_cache_max_age_days` equal
to `_MAX_AGE_DAYS`; the bucket also deletes objects older than that plus 7 days.

## Troubleshooting

Read `dependencyCache` in `get_run`; then match the `reason`:

| Reason                                                                                       | What to do                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `no_lockfile`, `lockfile_unreadable`, `no_package_json`, `no_dependencies`                   | Nothing to cache in that folder.                                                                                                  |
| `lockfile_version`                                                                           | Regenerate the lockfile with npm 7 or later.                                                                                      |
| `workspaces`, `workspace_member`, `shrinkwrap_present`                                       | Not supported; the agent installs itself.                                                                                         |
| `node_modules_present`, `cache_dir_unsafe`                                                   | Remove the committed `node_modules` or `.cache` (symlink) from the repository.                                                    |
| `too_many_projects`                                                                          | Only 4 projects per run are prepared.                                                                                             |
| `no_registry`, `plan_failed`, `plan_refused`                                                 | Give the agent a package allowlist and fix refused packages; see [Approve packages for coding agents](help://coding-packages).    |
| `cache_unavailable`, `plan_required`, `sealed`, `lookup_failed`, `download_failed`           | Check `WARDBY_DEPENDENCY_CACHE` and `BLOB_STORE` on the proxy, the store's permissions and the proxy log.                         |
| `size_mismatch`, `sha_mismatch`, `unsafe_archive`, `inconsistent`                            | The snapshot was not trusted; it is rebuilt when it ages out or is deleted. Repeats point at the blob store.                      |
| `too_large`, `over_budget`, `budget_unknown`, `budget_too_small`                             | Raise `WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB` or the agent's `workspaceDiskMb`.                                                 |
| `install_failed`, `timeout`, `cancelled`, `internal_error`, `worker_error`, `report_invalid` | The agent installs for itself; check the worker log. On Docker a huge restore can exhaust the tmpfs inode limit before its bytes. |
| `tool_unavailable`                                                                           | Claude Code tool-runner image predates the cache or is custom; rebuild it from the current tool-runner image.                     |
| `already_started`                                                                            | A command ran before preparation; not expected.                                                                                   |

`rebuild` of `failed`, `timeout` or `unsealed` means native add-ons may be
unbuilt; the agent can run `npm rebuild`.

The full reference, with every limit, is
[`docs/coding-packages.md`](../docs/coding-packages.md#dependency-cache).
