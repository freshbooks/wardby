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
    expect(doc.content?.map((n) => n.type)).toEqual([
      "heading",
      "bulletList",
      "orderedList",
      "codeBlock",
      "blockquote",
    ]);
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
  it("links bare https URLs, leaving trailing punctuation and other schemes as text", () => {
    const href = "https://example.atlassian.net/browse/PROJ-7";
    expect(markdownToAdf(`Created PROJ-7 at ${href}. (see ${href})`).content?.[0].content).toEqual([
      { type: "text", text: "Created PROJ-7 at " },
      { type: "text", text: href, marks: [{ type: "link", attrs: { href } }] },
      { type: "text", text: ". (see " },
      { type: "text", text: href, marks: [{ type: "link", attrs: { href } }] },
      { type: "text", text: ")" },
    ]);
    expect(JSON.stringify(markdownToAdf("plain http://example.com and ftp://x"))).not.toContain('"link"');
    expect(markdownToAdf("run `curl https://example.com/x`").content?.[0].content).toEqual([
      { type: "text", text: "run " },
      { type: "text", text: "curl https://example.com/x", marks: [{ type: "code" }] },
    ]);
  });
  it("makes smart links for this site's issue URLs and linked projects' issue keys only", () => {
    const smart = { siteUrl: "https://example.atlassian.net/", projectKeys: ["OPS"] };
    const card = (key: string) => ({
      type: "inlineCard",
      attrs: { url: `https://example.atlassian.net/browse/${key}` },
    });
    expect(
      markdownToAdf("Filed OPS-12 (see https://example.atlassian.net/browse/WEB-3). UTF-8 and XOPS-1 stay.", smart)
        .content?.[0].content,
    ).toEqual([
      { type: "text", text: "Filed " },
      card("OPS-12"),
      { type: "text", text: " (see " },
      card("WEB-3"),
      { type: "text", text: "). UTF-8 and XOPS-1 stay." },
    ]);
    const other = "https://elsewhere.example.com/browse/OPS-1";
    expect(markdownToAdf(`${other} \`OPS-1\` **OPS-2**`, smart).content?.[0].content).toEqual([
      { type: "text", text: other, marks: [{ type: "link", attrs: { href: other } }] },
      { type: "text", text: " " },
      { type: "text", text: "OPS-1", marks: [{ type: "code" }] },
      { type: "text", text: " " },
      { type: "text", text: "OPS-2", marks: [{ type: "strong" }] },
    ]);
    expect(JSON.stringify(markdownToAdf("OPS-12"))).not.toContain("inlineCard");
  });
  it("keeps snake_case identifiers literal but still italicises _word_", () => {
    expect(markdownToAdf("Set WARDBY_JIRA_API_TOKEN and my_var_name").content?.[0].content).toEqual([
      { type: "text", text: "Set WARDBY_JIRA_API_TOKEN and my_var_name" },
    ]);
    expect(markdownToAdf("an _italic_ word").content?.[0].content).toEqual([
      { type: "text", text: "an " },
      { type: "text", text: "italic", marks: [{ type: "em" }] },
      { type: "text", text: " word" },
    ]);
    expect(markdownToAdf("done\n\n_wardby agent agent-123_").content?.[1].content).toEqual([
      { type: "text", text: "wardby agent agent-123", marks: [{ type: "em" }] },
    ]);
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
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello " },
          { type: "mention", attrs: { id: "acc-1", text: "@Bot" } },
        ],
      },
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
  it("renders wiki-markup mentions in a string as @user", () => {
    expect(adfToText("[~accountid:bot-1] please fix")).toBe("@user please fix");
    expect(adfToText("hi [~accountId:557058:abc-123], see [link|https://x]")).toBe("hi @user, see [link|https://x]");
  });
});

describe("adfMentionIds", () => {
  it("reads wiki-markup mentions from a string body (webhook v2 shape)", () => {
    expect(adfMentionIds("[~accountid:bot-1] please fix, cc [~accountId:557058:abc-123]")).toEqual([
      "bot-1",
      "557058:abc-123",
    ]);
    expect(adfMentionIds("no mentions [~someone]")).toEqual([]);
  });
  it("collects mention account ids at any depth", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "acc-9" } }] }],
            },
          ],
        },
      ],
    };
    expect(adfMentionIds(doc)).toEqual(["acc-9"]);
  });
});
