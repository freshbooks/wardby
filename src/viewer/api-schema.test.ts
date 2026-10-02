import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderSchemas, SCHEMA_DIR } from "./build-schemas.js";

describe("published viewer schemas", () => {
  it("are up to date (run `npm run build:viewer-schemas` and commit)", async () => {
    for (const [file, text] of Object.entries(renderSchemas())) {
      expect(await readFile(join(SCHEMA_DIR, file), "utf8"), file).toBe(text);
    }
  });
});
