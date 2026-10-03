/**
 * A run is billed at the model catalog entry recorded when it started, for
 * its whole life: a resumed attempt (crash, pod move, reconciler adoption)
 * reads the entry back from its Run row instead of the live catalog, so an
 * admin's later set_model / disable_model never changes a run already under
 * way. Runs from before the catalog have no stored entry and use the current
 * catalog (identical to the shipped prices they started with).
 */
import type { Prisma } from "#prisma";
import type { LlmProvider } from "../providers/llm/types.js";
import { RoutingLlmProvider } from "../providers/llm/routing.js";
import { entryOf, parseStoredEntry, type CatalogEntry } from "../providers/llm/catalog-types.js";

export interface PinnedPricing {
  entry: CatalogEntry;
  priceVersion: string;
}

export interface RunPricingDb {
  run: {
    updateMany(args: {
      where: { id: string; pricingVersion: null };
      data: { pricingVersion: string; pricingSnapshot: Prisma.InputJsonValue };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: { pricingVersion: true; pricingSnapshot: true };
    }): Promise<{ pricingVersion: string | null; pricingSnapshot: unknown } | null>;
  };
}

function stored(row: { pricingVersion: string | null; pricingSnapshot: unknown }): PinnedPricing | undefined {
  const entry = parseStoredEntry(row.pricingSnapshot);
  return entry && row.pricingVersion ? { entry, priceVersion: row.pricingVersion } : undefined;
}

export async function pinNativeRunPricing(
  db: RunPricingDb,
  run: { id: string; pricingVersion: string | null; pricingSnapshot: unknown },
  model: string,
  llm: LlmProvider,
): Promise<PinnedPricing | undefined> {
  const existing = stored(run);
  if (existing) return existing;
  if (!(llm instanceof RoutingLlmProvider)) return undefined;
  const resolved = llm.entryFor(model); // throws ModelUnavailableError before any spend
  const entry = entryOf(resolved);
  const { count } = await db.run.updateMany({
    where: { id: run.id, pricingVersion: null },
    // entryOf returns plain JSON data (fresh array, no Dates); the interface's readonly
    // efforts array is all that keeps it from matching Prisma's Json input type.
    data: { pricingVersion: resolved.priceVersion, pricingSnapshot: entry as unknown as Prisma.InputJsonValue },
  });
  if (count === 1) return { entry, priceVersion: resolved.priceVersion };
  // Another attempt of this run recorded first: bill at what it recorded.
  const row = await db.run.findUnique({
    where: { id: run.id },
    select: { pricingVersion: true, pricingSnapshot: true },
  });
  return (row && stored(row)) ?? { entry, priceVersion: resolved.priceVersion };
}
