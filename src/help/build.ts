import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHelpCatalog } from "./catalog.js";

const helpRoot = fileURLToPath(new URL("../../help/", import.meta.url));
const output = fileURLToPath(new URL("../../dist/help-index.json", import.meta.url));

const catalog = await buildHelpCatalog(helpRoot);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
