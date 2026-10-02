/**
 * Atlassian Document Format helpers. Jira Cloud's v3 API takes and returns
 * rich text as ADF; webhook payloads use the v2 shape (wiki-markup strings),
 * so the readers (adfToText, adfMentionIds) accept both. Agents write a
 * small Markdown subset (markdownToAdf); the control plane reads issue text
 * as plain text (adfToText). Nothing here
 * produces HTML or mention nodes: a model can never ping a person.
 */
export interface AdfNode {
  type: string;
  version?: number;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

// `_x_` is italic only when the underscores aren't inside a word, so
// snake_case identifiers (WARDBY_JIRA_API_TOKEN, my_var_name) stay literal.
// A bare https:// URL becomes a link too; it ends before whitespace or a
// bracket and drops trailing sentence punctuation (`see https://x/y.`).
const INLINE =
  /\*\*([^*]+)\*\*|`([^`]+)`|(?<![A-Za-z0-9_])_([^_\s][^_]*?)_(?![A-Za-z0-9_])|\[([^\]]+)\]\(([^)\s]+)\)|(https:\/\/[^\s<>()[\]"']*[^\s<>()[\]"'.,;:!?])/g;

/**
 * Smart links (ADF inlineCard, what Jira's editor makes from a pasted issue link) for this site's
 * issues: a bare `<siteUrl>/browse/KEY-1` URL, and a bare `KEY-1` whose project is in `projectKeys`
 * (only those, so look-alikes such as UTF-8 or SHA-256 stay text).
 */
export interface SmartLinkOptions {
  siteUrl: string;
  projectKeys?: readonly string[];
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function inline(text: string, smart?: SmartLinkOptions): AdfNode[] {
  const out: AdfNode[] = [];
  const site = smart?.siteUrl.replace(/\/+$/, "");
  const card = (key: string): AdfNode => ({ type: "inlineCard", attrs: { url: `${site}/browse/${key}` } });
  const keys = (smart?.projectKeys ?? []).filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k));
  const keyRe = keys.length
    ? new RegExp(`(?<![A-Za-z0-9_/.-])(?:${keys.map(escapeRe).join("|")})-[1-9][0-9]*(?![A-Za-z0-9_-])`, "g")
    : null;
  const plain = (t: string) => {
    if (!t) return;
    if (!keyRe) return void out.push({ type: "text", text: t });
    let at = 0;
    for (const k of t.matchAll(keyRe)) {
      if (k.index > at) out.push({ type: "text", text: t.slice(at, k.index) });
      out.push(card(k[0]));
      at = k.index + k[0].length;
    }
    if (at < t.length) out.push({ type: "text", text: t.slice(at) });
  };
  const push = (t: string, marks?: AdfNode["marks"]) => {
    if (!t) return;
    if (marks) out.push({ type: "text", text: t, marks });
    else plain(t);
  };
  const siteIssueKey = (url: string): string | null => {
    if (!site || !url.startsWith(`${site}/browse/`)) return null;
    const key = url.slice(site.length + "/browse/".length);
    return ISSUE_KEY.test(key) ? key : null;
  };
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], [{ type: "strong" }]);
    else if (m[2] !== undefined) push(m[2], [{ type: "code" }]);
    else if (m[3] !== undefined) push(m[3], [{ type: "em" }]);
    else if (m[5]?.startsWith("https://")) push(m[4], [{ type: "link", attrs: { href: m[5] } }]);
    else if (m[6] !== undefined) {
      const key = siteIssueKey(m[6]);
      if (key) out.push(card(key));
      else push(m[6], [{ type: "link", attrs: { href: m[6] } }]);
    } else push(m[0]);
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

export function markdownToAdf(markdown: string, smart?: SmartLinkOptions): AdfNode {
  const paragraph = (text: string): AdfNode => ({ type: "paragraph", content: inline(text, smart) });
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      content.push({
        type: "codeBlock",
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: body.length ? [{ type: "text", text: body.join("\n") }] : [],
      });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({ type: "heading", attrs: { level: heading[1].length }, content: inline(heading[2], smart) });
      i++;
      continue;
    }
    const listOf = (re: RegExp, type: string) => {
      const items: AdfNode[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push({ type: "listItem", content: [paragraph(lines[i].replace(re, ""))] });
        i++;
      }
      content.push({ type, content: items });
    };
    if (/^\s*[-*]\s+/.test(line)) {
      listOf(/^\s*[-*]\s+/, "bulletList");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      listOf(/^\s*\d+\.\s+/, "orderedList");
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
      content.push({ type: "blockquote", content: [paragraph(quoted.join(" "))] });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|>)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    content.push(paragraph(para.join(" ")));
  }
  return { type: "doc", version: 1, content };
}

const BLOCKS = new Set(["paragraph", "heading", "codeBlock", "blockquote", "listItem", "rule", "panel", "tableRow"]);

/**
 * Webhook payloads carry rich text in the REST v2 shape: a wiki-markup
 * string, where a mention is `[~accountid:<accountId>]`.
 */
const WIKI_MENTION = /\[~accountid:([^\]\s]+)\]/gi;

export function adfToText(node: unknown, maxChars = 20_000): string {
  if (typeof node === "string") return cap(node.replace(WIKI_MENTION, "@user"), maxChars);
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const a = n as AdfNode;
    if (a.type === "text" && typeof a.text === "string") parts.push(a.text);
    else if (a.type === "mention") parts.push(typeof a.attrs?.text === "string" ? a.attrs.text : "@user");
    else if (a.type === "hardBreak") parts.push("\n");
    for (const c of a.content ?? []) walk(c);
    if (BLOCKS.has(a.type)) parts.push("\n");
  };
  walk(node);
  return cap(
    parts
      .join("")
      .replace(/\n{2,}/g, "\n")
      .trim(),
    maxChars,
  );
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function adfMentionIds(node: unknown): string[] {
  if (typeof node === "string") return [...node.matchAll(WIKI_MENTION)].map((m) => m[1]);
  const ids: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const a = n as AdfNode;
    if (a.type === "mention" && typeof a.attrs?.id === "string") ids.push(a.attrs.id);
    for (const c of a.content ?? []) walk(c);
  };
  walk(node);
  return ids;
}
