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

/** `npm rebuild` after the seal (hit, nearest and cold only): `skipped` when the lockfile lists no install script. */
export type RebuildOutcome = "ok" | "failed" | "timeout" | "skipped";

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
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The proxy origin; defaults to the one npm_config_registry / WARDBY_NPM_PLAN_REGISTRY names. */
  readonly proxyUrl?: string;
  /** The registry token; defaults to the npmrc's _authToken for that registry. */
  readonly token?: string;
  readonly npmPath?: string;
  readonly log?: DependencyCacheLog;
  /** Workspace disk budget in bytes; defaults to CODING_DISK_MB, else DEFAULT_BUDGET_MB. */
  readonly budgetBytes?: number;
  readonly timeouts?: Partial<DependencyCacheTimeouts>;
  /** Tests only: hooks into the flow. */
  readonly testHooks?: DependencyCacheTestHooks;
}

export interface DependencyCacheTestHooks {
  readonly beforeRename?: () => Promise<void>;
}

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
