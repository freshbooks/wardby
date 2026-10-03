/**
 * The merged model catalog: the shipped catalog (code) overlaid with a
 * deployment's ModelCatalogEntry rows (admins, via set_model). Immutable;
 * CatalogStore swaps in a new one on each refresh. Pure — no I/O.
 *
 * A row replaces the shipped entry with the same (provider, modelId)
 * completely; enabled=false removes the model; a row with no shipped match
 * adds one. Routing is by model id alone, so one model id can belong to only
 * one provider: a row that would claim an id another provider already serves
 * is skipped (set_model refuses it at write time; this is the backstop).
 */
import {
  MODEL_PROVIDERS,
  ModelUnavailableError,
  parseStoredEntry,
  sameEntry,
  type CatalogEntry,
  type CatalogRow,
  type ResolvedCatalogEntry,
} from "./catalog-types.js";
import { SHIPPED_CATALOG, SHIPPED_CATALOG_VERSION } from "./catalog-shipped.js";

export class ModelCatalog {
  constructor(
    private readonly active: ReadonlyMap<string, ResolvedCatalogEntry>,
    private readonly disabled: ReadonlyMap<string, ResolvedCatalogEntry>,
    private readonly shipped: ReadonlyMap<string, CatalogEntry>,
  ) {}

  get(modelId: string): ResolvedCatalogEntry | undefined {
    return this.active.get(modelId);
  }

  /** Throws ModelUnavailableError (not_in_catalog | disabled). */
  require(modelId: string): ResolvedCatalogEntry {
    const entry = this.active.get(modelId);
    if (entry) return entry;
    throw new ModelUnavailableError(modelId, this.disabled.has(modelId) ? "disabled" : "not_in_catalog");
  }

  entries(): ResolvedCatalogEntry[] {
    return [...this.active.values()];
  }

  disabledEntries(): ResolvedCatalogEntry[] {
    return [...this.disabled.values()];
  }

  shippedEntry(modelId: string): CatalogEntry | undefined {
    return this.shipped.get(modelId);
  }
}

export function buildCatalog(
  shipped: readonly CatalogEntry[],
  rows: readonly CatalogRow[],
  shippedVersion: string,
  onConflict: (message: string) => void = () => undefined,
): ModelCatalog {
  const shippedById = new Map(shipped.map((e) => [e.modelId, e]));
  const active = new Map<string, ResolvedCatalogEntry>(
    shipped.map((e) => [e.modelId, { ...e, origin: "shipped", priceVersion: `shipped:${shippedVersion}` }]),
  );
  const disabled = new Map<string, ResolvedCatalogEntry>();
  const sorted = [...rows].sort(
    (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.provider.localeCompare(b.provider),
  );
  const claimedByRow = new Map<string, string>(); // modelId -> provider of the first row that claimed it
  for (const row of sorted) {
    const shippedEntry = shippedById.get(row.modelId);
    const owner = claimedByRow.get(row.modelId) ?? shippedEntry?.provider;
    if (owner && owner !== row.provider) {
      onConflict(
        `ModelCatalogEntry (${row.provider}, ${row.modelId}) skipped: model id already served by provider "${owner}".`,
      );
      continue;
    }
    claimedByRow.set(row.modelId, row.provider);
    const resolved: ResolvedCatalogEntry = {
      provider: row.provider,
      modelId: row.modelId,
      encoding: row.encoding,
      inputPerMTok: row.inputPerMTok,
      outputPerMTok: row.outputPerMTok,
      cachedInputPerMTok: row.cachedInputPerMTok,
      cacheWritePerMTok: row.cacheWritePerMTok,
      efforts: [...row.efforts],
      thinkingMode: row.thinkingMode,
      origin: "override",
      priceVersion: row.updatedAt.toISOString(),
      ...(shippedEntry ? { shippedDiffers: !sameEntry(shippedEntry, row) } : {}),
      sourceUrl: row.sourceUrl,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
    if (row.enabled) {
      active.set(row.modelId, resolved);
    } else {
      active.delete(row.modelId);
      disabled.set(row.modelId, resolved);
    }
  }
  return new ModelCatalog(active, disabled, shippedById);
}

let shippedOnly: ModelCatalog | undefined;

/** The shipped catalog with no overrides (tests, tools without a database, old proxy sessions). */
export function shippedCatalog(): ModelCatalog {
  shippedOnly ??= buildCatalog(SHIPPED_CATALOG, [], SHIPPED_CATALOG_VERSION);
  return shippedOnly;
}

/** Validates one ModelCatalogEntry record; null (and the caller logs) if it is malformed. */
export function rowFromRecord(record: Record<string, unknown>): CatalogRow | null {
  const entry = parseStoredEntry(record);
  if (!entry) return null;
  if (typeof record.enabled !== "boolean") return null;
  if (typeof record.sourceUrl !== "string" || typeof record.updatedBy !== "string") return null;
  if (!(record.updatedAt instanceof Date)) return null;
  if (!(MODEL_PROVIDERS as readonly string[]).includes(entry.provider)) return null;
  return {
    ...entry,
    enabled: record.enabled,
    sourceUrl: record.sourceUrl,
    updatedBy: record.updatedBy,
    updatedAt: record.updatedAt,
  };
}
