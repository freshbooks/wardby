import { createHash } from "node:crypto";

/**
 * The pull request description wardby writes, as pure functions: the hash it
 * records, whether a fix round's final message is good enough to replace it,
 * whether a person has edited it since, and the comment that carries a
 * proposed description when wardby must not overwrite one.
 *
 * Depends on nothing else in providers/vcs, so github.ts can import it.
 */

/** Marks the Related pull requests section; replaced in place by later runs. */
export const RELATED_SECTION_START = "<!-- wardby-related:start -->";
export const RELATED_SECTION_END = "<!-- wardby-related:end -->";
/** The last line of a description a fix round rewrote: `<!-- wardby-latest:<runId> -->`. */
export const LATEST_RUN_MARKER_PREFIX = "<!-- wardby-latest:";
/**
 * The first line of the one description comment per pull request (edited in
 * place on later runs). Pull-request level, never per run, so there is only
 * ever one.
 */
export const DESCRIPTION_COMMENT_MARKER = "<!-- wardby-description -->";
/** An earlier per-run form of the marker (`<!-- wardby-description:<runId> -->`); such a comment is reused. */
const PER_RUN_DESCRIPTION_COMMENT_MARKER_PREFIX = "<!-- wardby-description:";
/** In the description comment once a later run applied its description directly: no proposal is pending. */
export const DESCRIPTION_COMMENT_APPLIED_MARKER = "<!-- wardby-description-applied -->";
const PROPOSAL_SUMMARY = "<details><summary>Proposed description</summary>";
/** A final message with fewer non-whitespace characters can't replace the description. */
export const MIN_PR_BODY_CHARS = 80;
/** The fallback comment stays under this many characters (GitHub's limit is 65,536). */
export const MAX_DESCRIPTION_COMMENT_CHARS = 60_000;

const RUN_MARKER_PREFIX = "<!-- wardby:";
/** Mirrors the runId shape validated in github.ts and coding/protocol.ts. */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** GitHub's closing keywords, then `#N` or `owner/repo#N`. */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:[\w.-]+\/[\w.-]+)?#\d+\b/i;

/** The marked Related block, START through END inclusive; undefined when absent or malformed (missing, reversed, repeated). */
export function extractRelatedBlock(body: string): string | undefined {
  const start = body.indexOf(RELATED_SECTION_START);
  const end = body.indexOf(RELATED_SECTION_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  if (body.indexOf(RELATED_SECTION_START, start + 1) !== -1 || body.indexOf(RELATED_SECTION_END, end + 1) !== -1) {
    return undefined;
  }
  return body.slice(start, end + RELATED_SECTION_END.length);
}

/**
 * The body as hashed: LF line endings, the Related block removed (it is
 * rewritten as other runs finish, which is not an edit), trailing whitespace
 * trimmed per line and at the end, and runs of blank lines collapsed to one.
 */
export function normalizeDescriptionForHash(body: string): string {
  let text = body.replace(/\r\n/g, "\n");
  const related = extractRelatedBlock(text);
  if (related) text = text.replace(related, "");
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** SHA-256 of the normalized body, lowercase hex. */
export function descriptionSha256(body: string): string {
  return createHash("sha256").update(normalizeDescriptionForHash(body), "utf8").digest("hex");
}

/** Whether the text contains a GitHub closing keyword and issue reference (`Fixes #3`, `resolves owner/repo#3`). */
export function hasClosingKeyword(text: string): boolean {
  return CLOSING_KEYWORD.test(text);
}

export type FinalMessageVerdict =
  { ok: true } | { ok: false; reason: "empty" | "too_short" | "missing_closing_keyword" };

/**
 * Whether `next` (a fix round's final message) can replace the description
 * whose agent-written text was `previous`: not empty, at least
 * MIN_PR_BODY_CHARS non-whitespace characters, and keeping a closing keyword
 * when the previous text had one.
 */
export function assessFinalMessage(next: string | undefined, previous: string | undefined): FinalMessageVerdict {
  const text = next?.trim() ?? "";
  if (!text) return { ok: false, reason: "empty" };
  if (text.replace(/\s/g, "").length < MIN_PR_BODY_CHARS) return { ok: false, reason: "too_short" };
  if (previous && hasClosingKeyword(previous) && !hasClosingKeyword(text)) {
    return { ok: false, reason: "missing_closing_keyword" };
  }
  return { ok: true };
}

/**
 * Whether the PR description is still what wardby last wrote. It must start
 * with the root run's marker, and its normalized hash must match the recorded
 * one. Without a recorded hash (a description written before hashes were
 * recorded), it must match `legacySha256`, the hash of the body wardby would
 * have written for the root run, rebuilt from stored records; without that
 * either it counts as edited, so a person's text is never overwritten.
 * `previousAgentText` does not decide edit status; it is carried for callers.
 */
export function isUneditedDescription(input: {
  currentBody: string;
  rootRunId: string;
  recordedSha256: string | null;
  legacySha256?: string;
  previousAgentText?: string | undefined;
}): boolean {
  const body = input.currentBody.replace(/\r\n/g, "\n");
  if (!body.startsWith(`${RUN_MARKER_PREFIX}${input.rootRunId} -->`)) return false;
  const expected = input.recordedSha256 ?? input.legacySha256;
  if (!expected) return false;
  return descriptionSha256(body) === expected;
}

/** A backtick fence one longer than the longest backtick run in `text` (at least three). */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Whether a comment is wardby's description comment: it starts with the marker (either form). */
export function isDescriptionComment(body: string): boolean {
  const text = body.replace(/\r\n/g, "\n");
  return text.startsWith(DESCRIPTION_COMMENT_MARKER) || text.startsWith(PER_RUN_DESCRIPTION_COMMENT_MARKER_PREFIX);
}

/**
 * The proposed description a fallback comment carries (the fenced block under
 * "Proposed description"); undefined when the comment holds none (an applied
 * comment, or any other text).
 */
export function extractProposedDescription(commentBody: string): string | undefined {
  const text = commentBody.replace(/\r\n/g, "\n");
  if (text.includes(DESCRIPTION_COMMENT_APPLIED_MARKER)) return undefined;
  const at = text.indexOf(PROPOSAL_SUMMARY);
  if (at === -1) return undefined;
  const open = /\n(`{3,})markdown\n/.exec(text.slice(at));
  if (!open) return undefined;
  const start = at + open.index + open[0].length;
  const close = text.indexOf(`\n${open[1]}\n`, start - 1);
  const end = close === -1 ? text.indexOf(`\n${open[1]}`, start - 1) : close;
  if (end < start - 1) return undefined;
  const proposal = text.slice(start, Math.max(start, end)).trimEnd();
  return proposal || undefined;
}

/** The run a fallback comment names as its proposer; undefined when it names none. */
export function proposingRunId(commentBody: string): string | undefined {
  const named = /latest run \(`([^`\n]+)`\)/.exec(commentBody)?.[1];
  return named && SAFE_RUN_ID.test(named) ? named : undefined;
}

/**
 * The pull request's description comment, carrying the description wardby's
 * latest run proposed when it could not apply it because a person edited the
 * description. There is one per pull request (DESCRIPTION_COMMENT_MARKER),
 * edited in place by later runs. Holds the body in a collapsed fenced block,
 * and stays under MAX_DESCRIPTION_COMMENT_CHARS (a long body is truncated).
 * Throws on a run id that isn't safe to quote.
 */
export function descriptionFallbackComment(runId: string, proposedBody: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("description_comment_run_id_invalid");
  const head = [
    DESCRIPTION_COMMENT_MARKER,
    "",
    `This is the current description proposed by wardby's latest run (\`${runId}\`). ` +
      "It was not applied because a person edited the description by hand since wardby last wrote it, and wardby never overwrites a person's edits. " +
      "The pull request author can copy it into the description. Later runs update this comment.",
    "",
    PROPOSAL_SUMMARY,
    "",
  ].join("\n");
  const truncatedNote = "\n\n_The proposed description was truncated to fit in a comment._";
  let body = proposedBody.replace(/\r\n/g, "\n").trimEnd();
  let note = "";
  const render = () => {
    const fence = fenceFor(body);
    return `${head}${fence}markdown\n${body}\n${fence}${note}\n\n</details>`;
  };
  let comment = render();
  if (comment.length >= MAX_DESCRIPTION_COMMENT_CHARS) {
    note = truncatedNote;
    // Headroom for the fence growing if the cut leaves a longer backtick run (it can't), plus the note.
    const overhead = comment.length - body.length + note.length + 64;
    body = body.slice(0, Math.max(0, MAX_DESCRIPTION_COMMENT_CHARS - overhead)).trimEnd();
    comment = render();
  }
  return comment;
}

/**
 * What the description comment becomes once a later run applied its
 * description directly: no proposal is pending, so nobody (a person or a
 * reviewer) acts on a stale one.
 */
export function descriptionAppliedComment(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("description_comment_run_id_invalid");
  return [
    DESCRIPTION_COMMENT_MARKER,
    DESCRIPTION_COMMENT_APPLIED_MARKER,
    "",
    `wardby's latest run (\`${runId}\`) updated the pull request description directly, so it is current. No proposed description is pending here.`,
  ].join("\n");
}
