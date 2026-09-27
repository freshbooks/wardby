import type { HelpCatalog, HelpPage } from "./catalog.js";
import { loadBundledHelpCatalog } from "./runtime.js";
import { searchHelp } from "./search.js";

function helpUsage(): string {
  return `usage:
  wardby help list
  wardby help search <terms>
  wardby help open <article-id>

Search is offline and fuzzy across titles, tags, headings, summaries, and article text.`;
}

function printPage(page: HelpPage): void {
  console.log(page.markdown.trim());
}

function printList(catalog: HelpCatalog): void {
  console.log(`Wardby help (${catalog.pages.length} articles)`);
  for (const page of catalog.pages) {
    console.log(`\n${page.id}\n  ${page.title} — ${page.summary}`);
  }
  console.log(
    "\nUse `wardby help search <terms>` to find an article, then `wardby help open <article-id>` to read it.",
  );
}

function printResults(catalog: HelpCatalog, query: string): void {
  const results = searchHelp(catalog, query);
  if (!results.length) {
    console.log(`No help articles matched "${query}".`);
    return;
  }

  console.log(`Help results for "${query}":`);
  for (const result of results.slice(0, 10)) {
    console.log(`\n${result.page.title} (${result.page.id})`);
    if (result.matchedHeading && result.matchedHeading.text !== result.page.title) {
      console.log(`  Match: ${result.matchedHeading.text}`);
    }
    console.log(`  ${result.excerpt}`);
  }
}

/** Runs the dependency-free, bundled help command. */
export async function helpCommand(args: string[]): Promise<void> {
  const catalog = await loadBundledHelpCatalog();
  const [operation, ...rest] = args;

  if (!operation || operation === "list") {
    printList(catalog);
    return;
  }
  if (operation === "search") {
    const query = rest.join(" ").trim();
    if (!query) throw new Error("help search requires one or more terms.\n\n" + helpUsage());
    printResults(catalog, query);
    return;
  }
  if (operation === "open") {
    const id = rest[0];
    if (!id || rest.length !== 1) throw new Error("help open requires exactly one article id.\n\n" + helpUsage());
    const page = catalog.pages.find((candidate) => candidate.id === id);
    if (!page) throw new Error(`unknown help article "${id}". Run \`wardby help list\` to see available articles.`);
    printPage(page);
    return;
  }

  throw new Error(`unknown help command "${operation}".\n\n${helpUsage()}`);
}
