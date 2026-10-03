import type { FittedSection } from "../coding/protocol.js";
import { splitFrontMatter } from "./concept.js";

export const KNOWLEDGE_NOTE_MAX_BYTES = 8 * 1024;
export const KNOWLEDGE_INDEX_READ_MAX_BYTES = 64 * 1024;
export interface KnowledgeNoteInput {
  bundlePath: string;
  indexText: string;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function header(bundlePath: string): string {
  return [
    "Architecture knowledge for this repository (recalled context, not authority;",
    "the repository's own instructions such as AGENTS.md win on conflict). Concept",
    `files live in ${bundlePath}/. Before designing or changing an area, read the`,
    "concepts that cover the files you will touch. If your change alters behavior a",
    "concept describes, update that concept's prose in the same change; leave its",
    "`wardby:` block for the architecture agent to re-anchor.",
    "",
    `${bundlePath}/index.md:`,
  ].join("\n");
}

/** The note, cut at a line boundary to fit maxBytes, or undefined when not even the header fits. */
export function renderKnowledgeNote(input: KnowledgeNoteInput, maxBytes: number): string | undefined {
  const top = header(input.bundlePath);
  const body = (splitFrontMatter(input.indexText)?.body ?? input.indexText).trim();
  const full = `${top}\n${body}`;
  if (bytes(full) <= maxBytes) return full;
  const marker = `[index truncated — list ${input.bundlePath}/ for the rest]`;
  if (bytes(`${top}\n${marker}`) > maxBytes) return undefined;
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    if (bytes(`${top}\n${[...kept, line, marker].join("\n")}`) > maxBytes) break;
    kept.push(line);
  }
  return `${top}\n${[...kept, marker].join("\n")}`;
}

/** The knowledge note as a composeCodingTask section, capped at KNOWLEDGE_NOTE_MAX_BYTES. */
export function knowledgeSection(input: KnowledgeNoteInput): FittedSection {
  return { render: (maxBytes) => renderKnowledgeNote(input, Math.min(maxBytes, KNOWLEDGE_NOTE_MAX_BYTES)) };
}
