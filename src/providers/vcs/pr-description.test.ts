import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appMarkerRunId } from "../review-host/github-events.js";
import { RELATED_SECTION_END, RELATED_SECTION_START, pullRequestBody, upsertRelatedSection } from "./github.js";
import {
  DESCRIPTION_COMMENT_APPLIED_MARKER,
  DESCRIPTION_COMMENT_MARKER,
  LATEST_RUN_MARKER_PREFIX,
  MIN_PR_BODY_CHARS,
  assessFinalMessage,
  descriptionAppliedComment,
  descriptionFallbackComment,
  descriptionSha256,
  extractProposedDescription,
  isDescriptionComment,
  extractRelatedBlock,
  hasClosingKeyword,
  isUneditedDescription,
  normalizeDescriptionForHash,
} from "./pr-description.js";

const SUMMARY =
  "Adds a shopping cart to the store page, with quantity controls and a running total shown in the header bar.";
const base = { runId: "run-root", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-root" };

function relatedBlock(line: string): string {
  return [RELATED_SECTION_START, "**Related pull requests**", "", line, RELATED_SECTION_END].join("\n");
}

describe("normalizeDescriptionForHash", () => {
  it("strips the Related section so a later replaceRelatedSection keeps the hash", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY });
    const withRelated = upsertRelatedSection(body, relatedBlock("- openai/other#4 (open)"));
    expect(withRelated).not.toBeNull();
    const replaced = upsertRelatedSection(withRelated!, relatedBlock("- openai/other#4 (merged)"));
    expect(normalizeDescriptionForHash(withRelated!)).toBe(normalizeDescriptionForHash(body));
    expect(descriptionSha256(replaced!)).toBe(descriptionSha256(body));
  });

  it("treats CRLF and LF bodies as equal", () => {
    const lf = `<!-- wardby:run-root -->\n\n${SUMMARY}\n\n**Tests:**\n- \`npm test\`: passed`;
    expect(normalizeDescriptionForHash(lf.replace(/\n/g, "\r\n"))).toBe(normalizeDescriptionForHash(lf));
  });

  it("collapses the blank lines left by removing a Related block", () => {
    const body = `<!-- wardby:run-root -->\n\n${relatedBlock("- x")}\n\n${SUMMARY}  \n\n\n\n`;
    expect(normalizeDescriptionForHash(body)).toBe(`<!-- wardby:run-root -->\n\n${SUMMARY}`);
  });

  it("leaves a malformed Related block in place", () => {
    const body = `<!-- wardby:run-root -->\n\n${RELATED_SECTION_START}\n- x\n\n${SUMMARY}`;
    expect(normalizeDescriptionForHash(body)).toContain(RELATED_SECTION_START);
  });
});

describe("descriptionSha256", () => {
  it("is stable for the body GitHub echoes back", () => {
    const written = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });
    const echoed = `${written.replace(/\n/g, "\r\n")}\r\n`;
    expect(descriptionSha256(echoed)).toBe(descriptionSha256(written));
    expect(descriptionSha256(written)).toMatch(/^[0-9a-f]{64}$/);
    expect(descriptionSha256(written)).toBe(
      createHash("sha256").update(normalizeDescriptionForHash(written), "utf8").digest("hex"),
    );
  });
});

describe("extractRelatedBlock", () => {
  it("returns the marked block inclusive, or undefined when malformed", () => {
    const block = relatedBlock("- x");
    expect(extractRelatedBlock(`a\n\n${block}\n\nb`)).toBe(block);
    expect(extractRelatedBlock("no block")).toBeUndefined();
    expect(extractRelatedBlock(`${RELATED_SECTION_START}\nx`)).toBeUndefined();
    expect(extractRelatedBlock(`${RELATED_SECTION_END}\nx\n${RELATED_SECTION_START}`)).toBeUndefined();
    expect(extractRelatedBlock(`${block}\n${block}`)).toBeUndefined();
  });
});

describe("assessFinalMessage", () => {
  it("rejects empty/whitespace", () => {
    expect(assessFinalMessage(undefined, undefined)).toEqual({ ok: false, reason: "empty" });
    expect(assessFinalMessage("  \n\t ", SUMMARY)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects under 80 characters", () => {
    expect(MIN_PR_BODY_CHARS).toBe(80);
    expect(assessFinalMessage("Done. Pushed the fixes.", undefined)).toEqual({ ok: false, reason: "too_short" });
    // 79 non-whitespace characters padded with spaces is still too short.
    const padded = `${"a ".repeat(79)}`;
    expect(assessFinalMessage(padded, undefined)).toEqual({ ok: false, reason: "too_short" });
    expect(assessFinalMessage("a".repeat(80), undefined)).toEqual({ ok: true });
  });

  it("rejects a message dropping `Resolves #12` the previous text had", () => {
    expect(assessFinalMessage(SUMMARY, `Resolves #12\n\n${SUMMARY}`)).toEqual({
      ok: false,
      reason: "missing_closing_keyword",
    });
  });

  it("accepts `Fixes owner/repo#3`", () => {
    expect(hasClosingKeyword("Fixes owner/repo#3")).toBe(true);
    expect(assessFinalMessage(`Fixes owner/repo#3\n\n${SUMMARY}`, `closes #3\n\n${SUMMARY}`)).toEqual({ ok: true });
  });

  it("accepts a full body when the previous had no keyword", () => {
    expect(assessFinalMessage(SUMMARY, "An earlier summary with no issue reference at all.")).toEqual({ ok: true });
  });

  it("recognizes the keyword forms case-insensitively and nothing else", () => {
    for (const k of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "RESOLVED"]) {
      expect(hasClosingKeyword(`${k} #7`)).toBe(true);
    }
    expect(hasClosingKeyword("Resolves Jira issue ABC-1")).toBe(false);
    expect(hasClosingKeyword("prefixes #7")).toBe(false);
    expect(hasClosingKeyword("see #7")).toBe(false);
  });
});

describe("isUneditedDescription", () => {
  const written = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });

  it("matches a recorded hash", () => {
    expect(
      isUneditedDescription({
        currentBody: written.replace(/\n/g, "\r\n"),
        rootRunId: "run-root",
        recordedSha256: descriptionSha256(written),
        previousAgentText: SUMMARY,
      }),
    ).toBe(true);
  });

  it("a differing hash is edited", () => {
    expect(
      isUneditedDescription({
        currentBody: `${written}\n\nA reviewer's note.`,
        rootRunId: "run-root",
        recordedSha256: descriptionSha256(written),
        previousAgentText: SUMMARY,
      }),
    ).toBe(false);
  });

  it("a body without the leading root marker is edited", () => {
    const noMarker = written.replace("<!-- wardby:run-root -->", "");
    expect(
      isUneditedDescription({
        currentBody: noMarker,
        rootRunId: "run-root",
        recordedSha256: descriptionSha256(noMarker),
        previousAgentText: SUMMARY,
      }),
    ).toBe(false);
    expect(
      isUneditedDescription({
        currentBody: written,
        rootRunId: "run-other",
        recordedSha256: descriptionSha256(written),
        previousAgentText: SUMMARY,
      }),
    ).toBe(false);
  });

  it("legacy (no hash) body with no reconstruction is treated as edited", () => {
    const legacy = pullRequestBody({ ...base, summary: SUMMARY });
    expect(
      isUneditedDescription({
        currentBody: legacy,
        rootRunId: "run-root",
        recordedSha256: null,
        previousAgentText: SUMMARY,
      }),
    ).toBe(false);
  });

  it("legacy (no hash): matches the reconstructed root body's hash, Related block and CRLF aside", () => {
    const legacy = pullRequestBody({ ...base, summary: SUMMARY });
    const withRelated = upsertRelatedSection(legacy, relatedBlock("- openai/other#4 (open)"))!;
    expect(
      isUneditedDescription({
        currentBody: withRelated.replace(/\n/g, "\r\n"),
        rootRunId: "run-root",
        recordedSha256: null,
        legacySha256: descriptionSha256(legacy),
        previousAgentText: SUMMARY,
      }),
    ).toBe(true);
  });

  it("legacy (no hash): a person's addition anywhere is edited", () => {
    const legacy = pullRequestBody({ ...base, summary: SUMMARY, tests: [{ command: "npm test", outcome: "passed" }] });
    const legacySha256 = descriptionSha256(legacy);
    const variants = [
      `${legacy}\n\nA reviewer's added note.`,
      legacy.replace(SUMMARY, `${SUMMARY} Also touches the checkout page.`),
      legacy.replace("**Tests:**", "Note from the author.\n\n**Tests:**"),
      legacy.replace("<!-- wardby:run-root -->", "<!-- wardby:run-root -->\n\nPlease review carefully."),
    ];
    for (const currentBody of variants) {
      expect(isUneditedDescription({ currentBody, rootRunId: "run-root", recordedSha256: null, legacySha256 })).toBe(
        false,
      );
    }
  });

  it("a recorded hash wins over a legacy reconstruction", () => {
    const legacy = pullRequestBody({ ...base, summary: SUMMARY });
    expect(
      isUneditedDescription({
        currentBody: legacy,
        rootRunId: "run-root",
        recordedSha256: "0".repeat(64),
        legacySha256: descriptionSha256(legacy),
      }),
    ).toBe(false);
  });
});

describe("pullRequestBody latest marker", () => {
  it("with latestRunId appends the latest marker last and keeps the root marker first", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });
    const lines = body.split("\n");
    expect(lines[0]).toBe("<!-- wardby:run-root -->");
    expect(lines.at(-1)).toBe(`${LATEST_RUN_MARKER_PREFIX}run-2 -->`);
    expect(pullRequestBody({ ...base, summary: SUMMARY })).not.toContain(LATEST_RUN_MARKER_PREFIX);
  });

  it("omits a latestRunId that is not a safe run id", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "x --> <script>" });
    expect(body).not.toContain(LATEST_RUN_MARKER_PREFIX);
  });

  it("`appMarkerRunId` still returns the root id", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });
    expect(appMarkerRunId({ user: { type: "Bot", login: "wardby[bot]" }, body }, "wardby")).toBe("run-root");
  });

  it("`upsertRelatedSection` still inserts after the root marker", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });
    const block = relatedBlock("- openai/other#4 (open)");
    const next = upsertRelatedSection(body, block);
    expect(next).toBe(`<!-- wardby:run-root -->\n\n${block}\n\n${SUMMARY}\n\n${LATEST_RUN_MARKER_PREFIX}run-2 -->`);
  });
});

describe("descriptionFallbackComment", () => {
  it("starts with the pull-request-level marker and names the latest run", () => {
    const comment = descriptionFallbackComment("run-2", SUMMARY);
    expect(comment.startsWith(`${DESCRIPTION_COMMENT_MARKER}\n`)).toBe(true);
    expect(comment).not.toContain("<!-- wardby-description:");
    expect(comment).toContain("current description proposed by wardby's latest run (`run-2`)");
    expect(comment).toContain("not applied because a person edited the description");
    expect(comment).toContain("can copy it into the description");
    expect(comment).toContain("<details><summary>Proposed description</summary>");
    expect(comment).toContain(`\`\`\`markdown\n${SUMMARY}\n\`\`\``);
    expect(comment.trimEnd().endsWith("</details>")).toBe(true);
    expect(isDescriptionComment(comment)).toBe(true);
  });

  it("fences a body containing triple backticks safely", () => {
    const proposed = "Example:\n\n```ts\nconst a = 1;\n```\n\nAnd ````four```` too.";
    const comment = descriptionFallbackComment("run-2", proposed);
    expect(comment).toContain(`\`\`\`\`\`markdown\n${proposed}\n\`\`\`\`\``);
    expect(extractProposedDescription(comment)).toBe(proposed);
  });

  it("is capped under 60,000 characters", () => {
    const comment = descriptionFallbackComment("run-2", "word ".repeat(30_000));
    expect(comment.length).toBeLessThan(60_000);
    expect(comment.startsWith(`${DESCRIPTION_COMMENT_MARKER}\n`)).toBe(true);
    expect(comment.trimEnd().endsWith("</details>")).toBe(true);
    expect(comment).toContain("truncated");
  });

  it("refuses an unsafe run id", () => {
    expect(() => descriptionFallbackComment("bad -->", SUMMARY)).toThrow();
  });
});

describe("descriptionAppliedComment", () => {
  it("keeps the marker, carries the applied marker, and holds no proposal", () => {
    const comment = descriptionAppliedComment("run-3");
    expect(comment.startsWith(`${DESCRIPTION_COMMENT_MARKER}\n`)).toBe(true);
    expect(comment).toContain(DESCRIPTION_COMMENT_APPLIED_MARKER);
    expect(comment).toContain("`run-3`");
    expect(isDescriptionComment(comment)).toBe(true);
    expect(extractProposedDescription(comment)).toBeUndefined();
  });

  it("refuses an unsafe run id", () => {
    expect(() => descriptionAppliedComment("bad -->")).toThrow();
  });
});

describe("isDescriptionComment / extractProposedDescription", () => {
  it("recognizes the pull-request-level marker and the earlier per-run one, at the start only", () => {
    expect(isDescriptionComment(`${DESCRIPTION_COMMENT_MARKER}\n\ntext`)).toBe(true);
    expect(isDescriptionComment("<!-- wardby-description:run-2 -->\n\ntext")).toBe(true);
    expect(isDescriptionComment(`> ${DESCRIPTION_COMMENT_MARKER}\n> quoted`)).toBe(false);
    expect(isDescriptionComment("<!-- wardby-status:run-2 -->")).toBe(false);
  });

  it("returns the proposal of a fallback comment, undefined for anything else", () => {
    expect(extractProposedDescription(descriptionFallbackComment("run-2", SUMMARY))).toBe(SUMMARY);
    expect(extractProposedDescription("just a comment")).toBeUndefined();
  });
});
