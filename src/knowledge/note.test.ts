import { describe, expect, it } from "vitest";
import { KNOWLEDGE_NOTE_MAX_BYTES, knowledgeSection, renderKnowledgeNote } from "./note.js";

const index = "---\nokf_version: 0.2\n---\n\n# Pitfalls\n\n* [A](a.md) - first\n* [B](b.md) - second\n";

describe("renderKnowledgeNote", () => {
  it("includes the framing, the bundle path, and the index without front-matter", () => {
    const note = renderKnowledgeNote({ bundlePath: "docs/knowledge", indexText: index }, 8192)!;
    expect(note).toContain("not authority");
    expect(note).toContain("docs/knowledge/index.md:");
    expect(note).toContain("* [B](b.md) - second");
    expect(note).not.toContain("okf_version");
  });
  it("cuts at a line boundary and marks the truncation", () => {
    // Long enough that the truncation marker costs less than the dropped lines.
    const longIndex = `${index}* [C](c.md) - ${"third concept ".repeat(10)}\n* [D](d.md) - ${"fourth concept ".repeat(10)}\n`;
    const full = renderKnowledgeNote({ bundlePath: "docs/knowledge", indexText: longIndex }, 8192)!;
    const cut = renderKnowledgeNote(
      { bundlePath: "docs/knowledge", indexText: longIndex },
      Buffer.byteLength(full) - 5,
    )!;
    expect(cut).not.toContain("fourth");
    expect(cut).toContain("* [A](a.md) - first");
    expect(cut).toContain("[index truncated");
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(Buffer.byteLength(full) - 5);
  });
  it("returns undefined when even the header does not fit", () => {
    expect(renderKnowledgeNote({ bundlePath: "docs/knowledge", indexText: index }, 50)).toBeUndefined();
  });
});

describe("knowledgeSection", () => {
  it("caps the note at KNOWLEDGE_NOTE_MAX_BYTES however much room there is", () => {
    const big = `# Index\n\n${"* [A](a.md) - a long description of a concept\n".repeat(1000)}`;
    const rendered = knowledgeSection({ bundlePath: "docs/knowledge", indexText: big }).render(100000)!;
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(KNOWLEDGE_NOTE_MAX_BYTES);
    expect(rendered).toContain("[index truncated");
  });
});
