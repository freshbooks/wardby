import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { HelpCatalog, HelpPage } from "./catalog.js";

const COMPILED_CATALOG = fileURLToPath(new URL("../help-index.json", import.meta.url));
const SOURCE_CATALOG = fileURLToPath(new URL("../../dist/help-index.json", import.meta.url));

function isPage(value: unknown): value is HelpPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<HelpPage>;
  return (
    typeof page.id === "string" &&
    typeof page.title === "string" &&
    typeof page.summary === "string" &&
    typeof page.markdown === "string" &&
    typeof page.plainText === "string" &&
    Array.isArray(page.tags) &&
    Array.isArray(page.headings)
  );
}

function parseCatalog(serialized: string): HelpCatalog {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object") throw new Error("bundled help catalog is not an object");
  const catalog = value as Partial<HelpCatalog>;
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.pages) || !catalog.pages.every(isPage)) {
    throw new Error("bundled help catalog has an unsupported format");
  }
  return catalog as HelpCatalog;
}

async function readCatalog(): Promise<HelpCatalog> {
  for (const path of [COMPILED_CATALOG, SOURCE_CATALOG]) {
    try {
      return parseCatalog(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Wardby help is unavailable because the bundled help catalog is missing. Run `npm run build`.");
}

let catalog: Promise<HelpCatalog> | undefined;

/** Loads the immutable help catalog bundled with this Wardby release, once per process. */
export function loadBundledHelpCatalog(): Promise<HelpCatalog> {
  catalog ??= readCatalog();
  return catalog;
}
