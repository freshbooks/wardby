/**
 * The merged model catalog: the shipped catalog (code) overlaid with a
 * deployment's ModelCatalogEntry rows (admins, via set_model). Immutable;
 * CatalogStore swaps in a new one on each refresh. Pure — no I/O.
 *
 * A row replaces the shipped entry with the same (provider, modelId)
 * completely; enabled=false removes the model; a row with no shipped match
 * adds one. Routing is by model id alone, so one model id can belong to only
 * one provider (ownerOf): a row that would claim an id another provider owns
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

/** What deciding a model id's owner needs from one of its ModelCatalogEntry rows. */
export interface CatalogClaim {
  provider: string;
  enabled: boolean;
  createdAt: Date;
}

/**
 * Orders claims on one model id: the earliest-created row first, ties broken
 * by provider name. createdAt, never updatedAt: an owner editing its own row
 * (set_model, disable_model) must not hand the id to a row claimed after it.
 */
export function compareClaims(a: CatalogClaim, b: CatalogClaim): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.provider.localeCompare(b.provider);
}

/**
 * The one ownership rule, shared by buildCatalog (the merge) and set_model
 * (its write-time conflict check), so the two can never disagree. A shipped
 * model id ALWAYS belongs to its shipped provider: any row for it under
 * another provider is a dead orphan, however many there are and whenever
 * they were written. A non-shipped id belongs to the provider of its
 * earliest-created row (compareClaims) until reset_model clears every row.
 * `enabled` is the owner's row's (a disabled row still reserves the id); a
 * shipped provider with no row is the untouched, enabled shipped entry.
 * Null only for an id that is neither shipped nor claimed by any row.
 *
 * Which rows count as claims is the caller's call: buildCatalog passes only
 * rows that passed rowFromRecord (CatalogStore drops malformed ones), while
 * set_model passes every raw row, malformed included, so a malformed row
 * still reserves its id until reset_model clears it.
 */
export function ownerOf(
  shippedEntry: Pick<CatalogEntry, "provider"> | undefined,
  claims: readonly CatalogClaim[],
): { provider: string; enabled: boolean } | null {
  if (shippedEntry) {
    const ownRow = claims.find((claim) => claim.provider === shippedEntry.provider);
    return { provider: shippedEntry.provider, enabled: ownRow ? ownRow.enabled : true };
  }
  if (claims.length === 0) return null;
  const [first] = [...claims].sort(compareClaims);
  return { provider: first.provider, enabled: first.enabled };
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
  const sorted = [...rows].sort(compareClaims);
  const rowsById = new Map<string, CatalogRow[]>();
  for (const row of sorted) rowsById.set(row.modelId, [...(rowsById.get(row.modelId) ?? []), row]);
  for (const row of sorted) {
    const shippedEntry = shippedById.get(row.modelId);
    // ownerOf is never null here (the id has at least this row); the fallback only satisfies the type.
    const owner = ownerOf(shippedEntry, rowsById.get(row.modelId) ?? [row])?.provider ?? row.provider;
    if (owner !== row.provider) {
      onConflict(
        `ModelCatalogEntry (${row.provider}, ${row.modelId}) skipped: model id already served by provider "${owner}".`,
      );
      continue;
    }
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
  if (!(record.createdAt instanceof Date) || !(record.updatedAt instanceof Date)) return null;
  if (!(MODEL_PROVIDERS as readonly string[]).includes(entry.provider)) return null;
  return {
    ...entry,
    enabled: record.enabled,
    sourceUrl: record.sourceUrl,
    updatedBy: record.updatedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
