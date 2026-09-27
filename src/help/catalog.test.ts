import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildHelpCatalog } from "./catalog.js";
import { SERVICE_REFUSAL_CODES, SERVICE_UNREADY_CATEGORY } from "../coding/services/wording.js";

const roots: string[] = [];

async function corpus(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wardby-help-"));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }),
  );
  return root;
}

function page(fields = "", body = "# Heading\n\nUseful text.\n"): string {
  return `---\nid: getting-started\ntitle: Getting started\nsummary: Start Wardby safely.\naudience: operator\ntags: [setup, operator]\nappliesTo: >=0.2.1\n${fields}---\n${body}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildHelpCatalog", () => {
  it("builds a stable catalog with searchable text and headings", async () => {
    const root = await corpus({
      "getting-started.md": page(
        "",
        "# Start here\n\nRun [the guide](#start-here).\n\n`wardby doctor` verifies the setup.\n",
      ),
    });

    await expect(buildHelpCatalog(root)).resolves.toEqual({
      schemaVersion: 1,
      pages: [
        expect.objectContaining({
          id: "getting-started",
          sourcePath: "getting-started.md",
          headings: [{ level: 1, text: "Start here", slug: "start-here" }],
          plainText: "Start here Run the guide. wardby doctor verifies the setup.",
        }),
      ],
    });
  });

  it("rejects duplicate ids and invalid internal links", async () => {
    const duplicate = await corpus({ "a.md": page(), "b.md": page("", "# Another\n") });
    await expect(buildHelpCatalog(duplicate)).rejects.toThrow('duplicate page id "getting-started"');

    const badLink = await corpus({ "getting-started.md": page("", "# Heading\n\n[Missing](missing.md)\n") });
    await expect(buildHelpCatalog(badLink)).rejects.toThrow('unknown help link "missing.md"');
  });

  it("rejects unknown metadata and missing required fields", async () => {
    const unknownField = await corpus({ "getting-started.md": page("owner: platform\n") });
    await expect(buildHelpCatalog(unknownField)).rejects.toThrow('unknown frontmatter field "owner"');

    const missingField = await corpus({
      "getting-started.md":
        "---\nid: getting-started\ntitle: Getting started\nsummary: Start Wardby safely.\naudience: operator\ntags: [setup]\n---\n# Heading\n",
    });
    await expect(buildHelpCatalog(missingField)).rejects.toThrow('missing frontmatter field "appliesTo"');
  });

  it("builds the checked-in corpus with a page for coding services and each of their errors", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const ids = new Set(catalog.pages.map((entry) => entry.id));

    expect(ids).toContain("coding-services");
    for (const code of [...SERVICE_REFUSAL_CODES, SERVICE_UNREADY_CATEGORY]) {
      const id = `errors/${code.replaceAll("_", "-")}`;
      expect(ids, id).toContain(id);
      expect(catalog.pages.find((entry) => entry.id === id)?.markdown).toContain(`\`${code}`);
    }
  });
});
