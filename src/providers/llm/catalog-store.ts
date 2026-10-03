/**
 * Holds this process's merged model catalog. Loads it at startup (failing
 * the process if the database is unreachable: running on the shipped catalog
 * alone would quietly re-enable models an admin turned off), then polls
 * ModelCatalogEntry every WARDBY_MODEL_CATALOG_REFRESH_SECONDS (default 45)
 * and swaps in a new immutable catalog. A failed poll keeps the last good
 * catalog. current() is synchronous: per-token pricing reads it.
 *
 * One store per process (serve, mcp, scheduler); installModelCatalog makes
 * it what currentModelCatalog() returns everywhere. Before a store is
 * installed (unit tests, offline CLI commands) currentModelCatalog() is the
 * shipped catalog.
 */
import { logger } from "../../core/logger.js";
import { buildCatalog, rowFromRecord, shippedCatalog, type ModelCatalog } from "./catalog.js";
import { SHIPPED_CATALOG, SHIPPED_CATALOG_VERSION } from "./catalog-shipped.js";
import type { CatalogRow } from "./catalog-types.js";

export interface CatalogDb {
  modelCatalogEntry: { findMany(): Promise<Record<string, unknown>[]> };
}

export interface CatalogLog {
  warn(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
}

const DEFAULT_REFRESH_SECONDS = 45;

export function refreshIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WARDBY_MODEL_CATALOG_REFRESH_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_REFRESH_SECONDS * 1000;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`WARDBY_MODEL_CATALOG_REFRESH_SECONDS must be a positive whole number of seconds (got "${raw}").`);
  }
  return Number(raw) * 1000;
}

export class CatalogStore {
  private catalog: ModelCatalog = shippedCatalog();
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;
  private readonly log: CatalogLog;

  constructor(
    private readonly db: CatalogDb,
    options: { intervalMs?: number; log?: CatalogLog } = {},
  ) {
    this.intervalMs = options.intervalMs ?? refreshIntervalMs();
    this.log = options.log ?? logger.child({ module: "model-catalog" });
  }

  async start(): Promise<void> {
    try {
      this.catalog = await this.load();
    } catch (err) {
      throw new Error(
        `Could not load the model catalog from the database: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    this.timer = setInterval(() => {
      this.load().then(
        (next) => {
          this.catalog = next;
        },
        (err: unknown) => {
          this.log.warn(
            { event: "models.catalog.refresh_failed", err: err instanceof Error ? err.message : String(err) },
            "model catalog refresh failed; keeping the last good catalog",
          );
        },
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  current(): ModelCatalog {
    return this.catalog;
  }

  async refreshNow(): Promise<void> {
    this.catalog = await this.load();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async load(): Promise<ModelCatalog> {
    const records = await this.db.modelCatalogEntry.findMany();
    const rows: CatalogRow[] = [];
    for (const record of records) {
      const row = rowFromRecord(record);
      if (row) rows.push(row);
      else
        this.log.warn(
          { event: "models.catalog.row_invalid", provider: record.provider, modelId: record.modelId },
          "skipping a malformed ModelCatalogEntry row",
        );
    }
    return buildCatalog(SHIPPED_CATALOG, rows, SHIPPED_CATALOG_VERSION, (message) =>
      this.log.warn({ event: "models.catalog.conflict" }, message),
    );
  }
}

let installed: CatalogStore | undefined;

export function installModelCatalog(store: CatalogStore): void {
  installed = store;
}

export function currentModelCatalog(): ModelCatalog {
  return installed?.current() ?? shippedCatalog();
}

export function uninstallModelCatalogForTests(): void {
  installed = undefined;
}
