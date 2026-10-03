/**
 * How an adapter finds the catalog entry for a model. The default reads the
 * process's current catalog; pinnedLookup binds an adapter to one run's
 * stored entry. Kept apart from the store so adapters depend only on this.
 */
import { ModelUnavailableError, type CatalogEntry } from "./catalog-types.js";
import { currentModelCatalog } from "./catalog-store.js";

/** Throws ModelUnavailableError for a model it does not serve. */
export type CatalogLookup = (model: string) => CatalogEntry;

export const currentLookup: CatalogLookup = (model) => currentModelCatalog().require(model);

export function pinnedLookup(entry: CatalogEntry): CatalogLookup {
  return (model) => {
    if (model !== entry.modelId) throw new ModelUnavailableError(model, "not_in_catalog");
    return entry;
  };
}
