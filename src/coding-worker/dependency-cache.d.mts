// Types for dependency-cache.mjs, so the driver and the tool runner's TypeScript callers can import it.

export type PrepareOutcome = "hit" | "nearest" | "cold" | "skipped" | "refused";

export interface PrepareResult {
  readonly result: PrepareOutcome;
  /** The proxy's opaque snapshot key for this run's lockfile (hit, nearest, cold). */
  readonly key?: string;
  /** Archive bytes downloaded (hit) or uploaded (nearest, cold). */
  readonly sizeBytes?: number;
  readonly restoreMs?: number;
  readonly installMs?: number;
  /** A stable code, never raw output: why it was skipped or refused, or why a cold tree was not snapshotted. */
  readonly reason?: string;
}

/** `npm rebuild` after the seal (hit, nearest and cold only): `skipped` when the lockfile lists no install
 *  script under node_modules/; `unsealed` when the proxy did not confirm the seal, so no third-party
 *  script ran while the upload window might still be open. */
export type RebuildOutcome = "ok" | "failed" | "timeout" | "skipped" | "unsealed";

export interface ProjectResult extends PrepareResult {
  /** The project folder relative to the workspace: "." for the root, else e.g. "app" or "web/client". */
  readonly path: string;
  readonly rebuild?: RebuildOutcome;
}

/** One entry per discovered project, root first then by path. A repo with no
 *  lockfile has one entry: `{ path: ".", result: "skipped", reason: "no_lockfile" }`.
 *  Skipped up front: `workspace_member`, `too_many_projects`. */
export interface PrepareDependenciesResult {
  readonly projects: readonly ProjectResult[];
  /** Set (with `projects: []`) only when the projects could not be planned at all: `internal_error` or `timeout`. */
  readonly reason?: string;
}

export interface DependencyCacheTimeouts {
  readonly httpMs: number;
  readonly transferMs: number;
  readonly transferMsPerMiB: number;
  readonly installMs: number;
  readonly tarMs: number;
  readonly totalMs: number;
  readonly killGraceMs: number;
  readonly settleMs: number;
  /** Each `npm rebuild` after the seal. */
  readonly rebuildMs: number;
  /** The proxy's upload window (WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS), measured from this module's start;
   *  a snapshot is not uploaded once less than `uploadMarginMs` of it is left (`upload_window_passed`,
   *  log only). Independent of `totalMs`: past the window a run still restores and installs, it only
   *  stops uploading. A lookup's `uploadExpiresInMs`, if a proxy reports one, wins when sooner. */
  readonly uploadWindowMs: number;
  readonly uploadMarginMs: number;
}

export type DependencyCacheLog = (event: string, fields: Record<string, unknown>) => void;

export interface DependencyCacheEvent {
  readonly event: string;
  readonly [field: string]: unknown;
}

export declare const DEFAULT_TIMEOUTS: Readonly<DependencyCacheTimeouts>;
export declare const DEFAULT_BUDGET_MB: number;
export declare const MAX_ARCHIVE_ENTRIES: number;
export declare const MAX_PROJECTS: number;

export interface PrepareDependenciesOptions {
  readonly workspace: string;
  /** Required: the agent-equivalent shell env (registry settings: npm_config_registry, npm_config_userconfig,
   *  WARDBY_NPM_PLAN_REGISTRY, PATH), never the driver's secrets. `npm rebuild` gets only PATH, HOME, LANG,
   *  TMPDIR and npm_config_* / NPM_CONFIG_* / WARDBY_NPM_* from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The proxy origin; defaults to the one npm_config_registry / WARDBY_NPM_PLAN_REGISTRY names. */
  readonly proxyUrl?: string;
  /** The registry token; defaults to the npmrc's _authToken for that registry. */
  readonly token?: string;
  readonly npmPath?: string;
  readonly log?: DependencyCacheLog;
  /** Workspace disk budget in bytes; defaults to CODING_DISK_MB, else DEFAULT_BUDGET_MB. */
  readonly budgetBytes?: number;
  readonly timeouts?: Partial<DependencyCacheTimeouts>;
  /** The run's cancellation: aborting it ends the work like the deadline (the module still seals and settles). */
  readonly signal?: AbortSignal;
  /** Tests only: hooks into the flow. */
  readonly testHooks?: DependencyCacheTestHooks;
}

export interface DependencyCacheTestHooks {
  readonly beforeRename?: () => Promise<void>;
  readonly beforeDiscovery?: () => Promise<void>;
}

export declare const MIN_BUDGET_BYTES: number;
export declare const BUDGET_MEASURE_TIMEOUT_MS: number;

export interface DependencyCacheBudgetOptions {
  readonly workspace: string;
  /** The run's workspace volume size in MiB (CodingTaskInput.diskMb / the tool setup's diskMb). */
  readonly diskMb: number | undefined;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxEntries?: number;
}

export type DependencyCacheBudget =
  | { readonly budgetBytes: number; readonly usedBytes: number; readonly reason?: undefined }
  | {
      readonly reason: "budget_unknown" | "budget_too_small";
      readonly usedBytes?: number;
      readonly budgetBytes?: undefined;
    };

/** diskMb MiB − the workspace's current usage − max(64 MiB, 5%); a skip reason when unknown or too small. Never throws. */
export declare function dependencyCacheBudget(options: DependencyCacheBudgetOptions): Promise<DependencyCacheBudget>;

export interface SealUploadWindowOptions {
  /** The same agent-equivalent env `prepareDependencies` takes (registry settings and the npmrc). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly proxyUrl?: string;
  readonly token?: string;
  /** Defaults to DEFAULT_TIMEOUTS.httpMs. */
  readonly timeoutMs?: number;
}

/** POST /cache/npm/seal on its own (idempotent on the proxy). `status` 0: no registry, or no answer. Never throws. */
export declare function sealUploadWindow(
  options: SealUploadWindowOptions,
): Promise<{ readonly status: number; readonly confirmed: boolean }>;

export declare function prepareDependencies(options: PrepareDependenciesOptions): Promise<PrepareDependenciesResult>;

/** Project folders with a committed package-lock.json, root first then by path (no cap applied). */
export declare function discoverProjects(workspace: string, signal?: AbortSignal): Promise<string[]>;

export interface PrepareProjectOptions {
  readonly workspace: string;
  readonly projectPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly npmPath: string;
  readonly log: DependencyCacheLog;
  readonly auth: { readonly base: string; readonly token: string } | undefined;
  /** Shared across projects: decremented by what each restore unpacks. */
  readonly budget: { remaining: number };
  readonly timeouts: DependencyCacheTimeouts;
  readonly signal: AbortSignal;
  /** `sealed` is set before the seal is sent (no upload starts after it);
   *  `closed` once the caller stops waiting (no workspace change after it). */
  readonly session: { sealed: boolean; closed: boolean; children: Set<number>; temps?: Set<string> };
  readonly testHooks?: DependencyCacheTestHooks;
  /** Filled from the committed lockfile before anything runs: whether `npm rebuild` is needed. */
  readonly facts?: { needsRebuild?: boolean };
  /** Epoch ms after which no snapshot upload starts. */
  readonly uploadDeadline?: number;
}

export declare function prepareProject(options: PrepareProjectOptions): Promise<PrepareResult>;

export declare function scanArchive(
  file: string,
  options: { budgetBytes: number; maxEntries?: number; signal?: AbortSignal },
): Promise<{ entries: number; unpackedBytes: number }>;

export declare function extractArchive(
  file: string,
  destination: string,
  options: { budgetBytes: number; maxEntries?: number; signal?: AbortSignal },
): Promise<void>;

export declare function verifyTree(root: string, signal?: AbortSignal): Promise<void>;

export declare function checkConsistency(
  projectRoot: string,
  lockfile: { packages: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; detail: string }>;
