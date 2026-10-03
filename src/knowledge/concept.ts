import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_KNOWLEDGE_BUNDLE_PATH = "docs/knowledge";
export const RESERVED_BUNDLE_FILES = new Set(["index.md", "log.md"]);

const CitationSchema = z.object({
  id: z.string().min(1).optional(),
  repo: z.string().min(1),
  path: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "path must be repo-relative"),
  lines: z
    .tuple([z.number().int().min(1), z.number().int().min(1)])
    .refine(([a, b]) => b >= a, "lines must be [start, end] with end >= start")
    .optional(),
  symbol: z.string().min(1).optional(),
  sha: z.string().regex(/^[0-9a-f]{40}$/, "sha must be a full 40-hex commit"),
  spanHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, "spanHash must be sha256:<64 hex>"),
});

const WardbyBlockSchema = z
  .object({
    schema: z.literal(1),
    roles: z.array(z.enum(["builder", "reviewer", "planner"])).default([]),
    affects: z.array(z.string().min(1)).default([]),
    citations: z.array(CitationSchema).default([]),
    supersedes: z.string().nullable().optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  })
  .passthrough();

const FrontMatterSchema = z
  .object({
    type: z.string().trim().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(["draft", "stable", "deprecated"]).default("stable"),
    wardby: WardbyBlockSchema.optional(),
  })
  .passthrough();

export type KnowledgeCitation = z.infer<typeof CitationSchema>;
export interface ParsedConcept {
  path: string;
  type: string;
  title?: string;
  description?: string;
  status: "draft" | "stable" | "deprecated";
  roles: string[];
  affects: string[];
  citations: KnowledgeCitation[];
  body: string;
  frontMatter: Record<string, unknown>;
}
export type ParseResult = { ok: true; concept: ParsedConcept } | { ok: false; error: string };

export function splitFrontMatter(text: string): { yaml: string; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return match ? { yaml: match[1], body: match[2] } : null;
}

export function parseConcept(path: string, text: string): ParseResult {
  const base = path.split("/").pop() ?? path;
  if (RESERVED_BUNDLE_FILES.has(base)) return { ok: false, error: `${base} is reserved and cannot be a concept` };
  const split = splitFrontMatter(text);
  if (!split) return { ok: false, error: "missing YAML front-matter (--- ... ---)" };
  let raw: unknown;
  try {
    raw = parseYaml(split.yaml);
  } catch (error) {
    return { ok: false, error: `invalid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = FrontMatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue.path.join(".") || "front-matter"}: ${issue.message}` };
  }
  const fm = parsed.data;
  return {
    ok: true,
    concept: {
      path,
      type: fm.type,
      title: fm.title,
      description: fm.description,
      status: fm.status,
      roles: fm.wardby?.roles ?? [],
      affects: fm.wardby?.affects ?? [],
      citations: fm.wardby?.citations ?? [],
      body: split.body,
      frontMatter: raw as Record<string, unknown>,
    },
  };
}
