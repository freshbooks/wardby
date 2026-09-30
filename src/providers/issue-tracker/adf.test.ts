import { describe, expect, it } from "vitest";
import { adfMentionIds, adfToText, markdownToAdf } from "./adf.js";

describe("markdownToAdf", () => {
  it("builds paragraphs with inline marks and links", () => {
    expect(markdownToAdf("Hi **there** `x` _y_ [docs](https://example.com)")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi " },
            { type: "text", text: "there", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "x", marks: [{ type: "code" }] },
            { type: "text", text: " " },
            { type: "text", text: "y", marks: [{ type: "em" }] },
            { type: "text", text: " " },
            { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
          ],
        },
      ],
    });
  });
  it("handles headings, lists, code blocks and quotes", () => {
    const doc = markdownToAdf("## Title\n\n- a\n- b\n\n1. one\n\n```ts\nconst x = 1;\n```\n\n> quoted");
    expect(doc.content?.map((n) => n.type)).toEqual(["heading", "bulletList", "orderedList", "codeBlock", "blockquote"]);
    expect(doc.content?.[0].attrs).toEqual({ level: 2 });
    expect(doc.content?.[3]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    });
  });
  it("never makes a non-https link or a mention", () => {
    const doc = markdownToAdf("[x](javascript:alert(1)) @someone");
    expect(JSON.stringify(doc)).not.toContain('"link"');
    expect(JSON.stringify(doc)).not.toContain('"mention"');
  });
  it("returns a valid empty doc for empty input", () => {
    expect(markdownToAdf("")).toEqual({ type: "doc", version: 1, content: [] });
  });
});

describe("adfToText", () => {
  const doc = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "mention", attrs: { id: "acc-1", text: "@Bot" } }] },
      { type: "codeBlock", content: [{ type: "text", text: "x = 1" }] },
    ],
  };
  it("flattens blocks with newlines and renders mentions by their text", () => {
    expect(adfToText(doc)).toBe("Hello @Bot\nx = 1");
  });
  it("caps output", () => {
    expect(adfToText(doc, 5)).toBe("Hello…");
  });
  it("accepts a plain string (API v2 style) and junk", () => {
    expect(adfToText("plain")).toBe("plain");
    expect(adfToText(null)).toBe("");
  });
});

describe("adfMentionIds", () => {
  it("collects mention account ids at any depth", () => {
    const doc = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "acc-9" } }] }] }] }] };
    expect(adfMentionIds(doc)).toEqual(["acc-9"]);
  });
});
