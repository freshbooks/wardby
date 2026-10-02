/** Writes src/viewer/schemas/<name>.schema.json from VIEWER_SCHEMAS (npm run build:viewer-schemas). */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { VIEWER_SCHEMAS } from "./api-schema.js";

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "schemas");

export function renderSchemas(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(VIEWER_SCHEMAS).map(([name, schema]) => [
      `${name}.schema.json`,
      `${JSON.stringify(zodToJsonSchema(schema, { name, $refStrategy: "none" }), null, 2)}\n`,
    ]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(SCHEMA_DIR, { recursive: true });
  for (const [file, text] of Object.entries(renderSchemas())) await writeFile(join(SCHEMA_DIR, file), text);
}
