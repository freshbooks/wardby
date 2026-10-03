/**
 * The model catalog over MCP (docs/models.md). Reading it (list_models,
 * get_model) needs only agents:read: anyone deciding what to put in an
 * Agent.model needs to see what's routable, what it costs, and whether it's
 * shipped or a deployment override — entries hold no secrets. Changing it
 * (set_model, disable_model, reset_model) needs models:admin, a privileged
 * scope honoured only with a role granting it (model-manager or admin;
 * resource-server.ts): an entry decides what every principal's runs on that
 * model id are priced and shaped as. Each change is audit-logged (event
 * models.catalog.<action>). Runs already dispatched keep the entry they
 * started with (CatalogEntry snapshots, not live lookups) — a write here
 * never reprices or reshapes a run in flight.
 *
 * Writes go straight to ModelCatalogEntry via `ctx.db`, then refresh the
 * process's installed CatalogStore (`deps.refresh`) before reading the
 * merged view back from `currentModelCatalog()`, so every response reflects
 * exactly what routing will use next. A process with no store installed
 * (or a caller that passed no `refresh`) still gets a response — it just
 * won't reflect the write until the next poll.
 */
import { z } from "zod";
import { logger } from "../../core/logger.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";
import {
  MODEL_PROVIDERS,
  THINKING_MODES,
  TOKENIZER_ENCODINGS,
  entryOf,
  type CatalogEntry,
  type ResolvedCatalogEntry,
} from "../../providers/llm/catalog-types.js";
import { LLM_EFFORT_LEVELS } from "../../providers/llm/types.js";
import { currentModelCatalog } from "../../providers/llm/catalog-store.js";
import { SHIPPED_CATALOG_VERSION } from "../../providers/llm/catalog-shipped.js";
import type { RoutingLlmProvider } from "../../providers/llm/routing.js";

const modelsLog = logger.child({ module: "mcp-model-catalog" });

const RATE_FIELDS = ["inputPerMTok", "outputPerMTok", "cachedInputPerMTok", "cacheWritePerMTok"] as const;

export interface ModelCatalogToolDeps {
  /** Rebuilds the process's installed CatalogStore after a write; omitted in contexts with no store. */
  refresh?: () => Promise<void>;
}

function parse<Output>(schema: z.ZodType<Output, z.ZodTypeDef, unknown>, label: string, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    throw new McpError(400, `Invalid ${label}: ${details}`);
  }
  return result.data;
}

const ModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/-]+$/, "modelId must match ^[A-Za-z0-9._:/-]+$");

const ModelIdArgSchema = z.object({ modelId: ModelIdSchema }).strict();
const ListModelsSchema = z.object({ includeDisabled: z.boolean().optional() }).strict();

const SetModelSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    modelId: ModelIdSchema,
    encoding: z.enum(TOKENIZER_ENCODINGS),
    inputPerMTok: z.number().finite().nonnegative(),
    outputPerMTok: z.number().finite().nonnegative(),
    cachedInputPerMTok: z.number().finite().nonnegative(),
    cacheWritePerMTok: z.number().finite().nonnegative(),
    efforts: z
      .array(z.enum(LLM_EFFORT_LEVELS))
      .refine((efforts) => new Set(efforts).size === efforts.length, "efforts must not repeat a level"),
    thinkingMode: z.enum(THINKING_MODES),
    sourceUrl: z
      .string()
      .url()
      .refine((url) => url.startsWith("https://"), "sourceUrl must start with https://"),
  })
  .strict();

type SetModelInput = z.infer<typeof SetModelSchema>;

/** A resolved entry as the tools serve it: the merged fields plus whether this deployment can route to it right now. */
function view(entry: ResolvedCatalogEntry, llm: RoutingLlmProvider): ResolvedCatalogEntry & { routable: boolean } {
  return { ...entry, routable: llm.hasProvider(entry.provider) };
}

function audit(
  ctx: McpRequestContext,
  action: "set" | "disable" | "reset",
  info: {
    provider: string;
    modelId: string;
    sourceUrl?: string;
    before: CatalogEntry | null;
    after: CatalogEntry | null;
  },
): void {
  modelsLog.info(
    {
      event: `models.catalog.${action}`,
      provider: info.provider,
      modelId: info.modelId,
      sourceUrl: info.sourceUrl,
      before: info.before,
      after: info.after,
      by: ctx.principal.id,
    },
    "model catalog changed",
  );
}

const modelIdProperty = {
  type: "string",
  description: 'Exact string an Agent.model must equal, e.g. "claude-sonnet-5".',
};

const setModelProperties = {
  provider: { type: "string", enum: [...MODEL_PROVIDERS], description: "Which adapter routes calls to this model." },
  modelId: modelIdProperty,
  encoding: {
    type: "string",
    enum: [...TOKENIZER_ENCODINGS],
    description: "Tokenizer encoding used to pre-count tokens for budget enforcement before any call.",
  },
  inputPerMTok: {
    type: "number",
    minimum: 0,
    description: "USD per million input tokens, the provider's published rate.",
  },
  outputPerMTok: {
    type: "number",
    minimum: 0,
    description: "USD per million output tokens, the provider's published rate.",
  },
  cachedInputPerMTok: {
    type: "number",
    minimum: 0,
    description:
      "USD per million cache-read input tokens. The provider's own cache-read rate, never derived from inputPerMTok.",
  },
  cacheWritePerMTok: {
    type: "number",
    minimum: 0,
    description:
      "USD per million cache-write input tokens. The provider's own cache-write rate, never derived from inputPerMTok.",
  },
  efforts: {
    type: "array",
    items: { type: "string", enum: [...LLM_EFFORT_LEVELS] },
    description: "Reasoning effort levels this model accepts, lowest to highest; empty = never send one.",
  },
  thinkingMode: {
    type: "string",
    enum: [...THINKING_MODES],
    description:
      '"adaptive" (effort-based), "manual" (fixed budget_tokens, no effort), or "none" (no thinking parameter).',
  },
  sourceUrl: {
    type: "string",
    description:
      "The provider's own pricing page for this exact model (https). Rates must be its published numbers, never derived.",
  },
};

export function registerModelCatalogTools(mcp: WardbyMcpServer, deps: ModelCatalogToolDeps = {}): void {
  mcp.registerTool({
    name: "list_models",
    scope: "agents:read",
    description:
      "The merged model catalog (shipped models overlaid with this deployment's overrides): id, pricing, encoding, effort levels, and whether this deployment can route to it right now (routable).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeDisabled: { type: "boolean", description: "Also return models an admin has disabled." },
      },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { includeDisabled } = parse(ListModelsSchema, "list_models arguments", rawArgs);
      const catalog = currentModelCatalog();
      const llm = ctx.providers.llm as RoutingLlmProvider;
      const result: { models: unknown[]; disabled?: unknown[] } = {
        models: catalog.entries().map((entry) => view(entry, llm)),
      };
      if (includeDisabled) result.disabled = catalog.disabledEntries().map((entry) => view(entry, llm));
      return textResult(result);
    },
  });

  mcp.registerTool({
    name: "get_model",
    scope: "agents:read",
    description:
      "One catalog entry in full, active or disabled. For an override of a shipped model, also returns the shipped entry it shadows.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["modelId"],
      properties: { modelId: modelIdProperty },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { modelId } = parse(ModelIdArgSchema, "get_model arguments", rawArgs);
      const catalog = currentModelCatalog();
      const entry = catalog.get(modelId) ?? catalog.disabledEntries().find((e) => e.modelId === modelId);
      if (!entry) {
        throw new McpError(
          404,
          `Model "${modelId}" is not in the catalog (neither active nor disabled). See list_models.`,
        );
      }
      const llm = ctx.providers.llm as RoutingLlmProvider;
      const shipped = entry.origin === "override" ? catalog.shippedEntry(modelId) : undefined;
      return textResult({ model: view(entry, llm), ...(shipped ? { shipped } : {}) });
    },
  });

  mcp.registerTool({
    name: "set_model",
    scope: "models:admin",
    description:
      "Model managers (models:admin): add or override a catalog entry. Every field is required — there is no partial update, so the whole entry is always literal and auditable. Refused when the model id is already claimed, under a different provider, by an active entry, a disabled entry, or a shipped model (reset or disable it first). Zero rates come back as warnings, not errors.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "provider",
        "modelId",
        "encoding",
        "inputPerMTok",
        "outputPerMTok",
        "cachedInputPerMTok",
        "cacheWritePerMTok",
        "efforts",
        "thinkingMode",
        "sourceUrl",
      ],
      properties: setModelProperties,
    },
    handler: async (rawArgs: unknown, ctx) => {
      const input: SetModelInput = parse(SetModelSchema, "set_model arguments", rawArgs);
      const catalog = currentModelCatalog();

      // One model id belongs to exactly one provider. The merged `active` map
      // already carries every shipped-and-untouched entry, so checking it
      // catches both "shipped, never overridden" and "enabled override"
      // conflicts. A disabled row is removed from `active` on disable, so it
      // needs its own check — it still reserves the id for its provider
      // until reset_model clears it (buildCatalog's own conflict skip is a
      // backstop for this, not the primary guard).
      const active = catalog.get(input.modelId);
      if (active && active.provider !== input.provider) {
        throw new McpError(
          409,
          `Model "${input.modelId}" is already served by provider "${active.provider}"; reset or disable it first.`,
        );
      }
      const disabled = catalog.disabledEntries().find((e) => e.modelId === input.modelId);
      if (disabled && disabled.provider !== input.provider) {
        throw new McpError(
          409,
          `Model "${input.modelId}" is reserved by a disabled entry for provider "${disabled.provider}"; reset_model it first.`,
        );
      }
      const before: CatalogEntry | null = active ? entryOf(active) : disabled ? entryOf(disabled) : null;

      const { sourceUrl, ...entry } = input;
      const data = { ...entry, efforts: [...entry.efforts], enabled: true, sourceUrl, updatedBy: ctx.principal.id };
      await ctx.db.modelCatalogEntry.upsert({
        where: { provider_modelId: { provider: input.provider, modelId: input.modelId } },
        create: data,
        update: data,
      });

      await deps.refresh?.();
      const updated = currentModelCatalog();
      const after = updated.get(input.modelId) ?? updated.disabledEntries().find((e) => e.modelId === input.modelId);
      audit(ctx, "set", {
        provider: input.provider,
        modelId: input.modelId,
        sourceUrl,
        before,
        after: after ? entryOf(after) : null,
      });

      const warnings = RATE_FIELDS.filter((field) => input[field] === 0).map(
        (field) => `${field} is 0: confirm against ${sourceUrl}`,
      );

      const llm = ctx.providers.llm as RoutingLlmProvider;
      const model = after
        ? view(after, llm)
        : view(
            {
              ...entry,
              origin: "override",
              priceVersion: new Date().toISOString(),
              sourceUrl,
              updatedBy: ctx.principal.id,
            },
            llm,
          );
      return textResult({ model, warnings });
    },
  });

  mcp.registerTool({
    name: "disable_model",
    scope: "models:admin",
    description:
      "Model managers (models:admin): remove a model from routing without deleting its history. Keeps a disabled row under its own provider so no other provider can claim the id until reset_model clears it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["modelId"],
      properties: { modelId: modelIdProperty },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { modelId } = parse(ModelIdArgSchema, "disable_model arguments", rawArgs);
      const catalog = currentModelCatalog();
      const active = catalog.get(modelId);
      if (!active) {
        throw new McpError(
          404,
          `No active model "${modelId}" to disable (it may already be disabled, or unknown). See list_models.`,
        );
      }
      const before = entryOf(active);
      const sourceUrl = active.sourceUrl ?? `shipped:${SHIPPED_CATALOG_VERSION}`;
      const data = {
        ...entryOf(active),
        efforts: [...active.efforts],
        enabled: false,
        sourceUrl,
        updatedBy: ctx.principal.id,
      };
      await ctx.db.modelCatalogEntry.upsert({
        where: { provider_modelId: { provider: active.provider, modelId } },
        create: data,
        update: data,
      });

      await deps.refresh?.();
      const updated = currentModelCatalog();
      const disabledEntry = updated.disabledEntries().find((e) => e.modelId === modelId);
      audit(ctx, "disable", {
        provider: active.provider,
        modelId,
        sourceUrl,
        before,
        after: disabledEntry ? entryOf(disabledEntry) : null,
      });

      const llm = ctx.providers.llm as RoutingLlmProvider;
      const disabledView = disabledEntry
        ? view(disabledEntry, llm)
        : view(
            {
              ...entryOf(active),
              origin: "override",
              priceVersion: new Date().toISOString(),
              sourceUrl,
              updatedBy: ctx.principal.id,
            },
            llm,
          );
      return textResult({ disabled: disabledView });
    },
  });

  mcp.registerTool({
    name: "reset_model",
    scope: "models:admin",
    description:
      "Model managers (models:admin): remove every catalog row for a model id, reverting to the shipped entry (if any) or removing it entirely. 404 if there is no row to remove (an unmodified shipped model, or an unknown id).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["modelId"],
      properties: { modelId: modelIdProperty },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { modelId } = parse(ModelIdArgSchema, "reset_model arguments", rawArgs);
      const catalog = currentModelCatalog();
      const active = catalog.get(modelId);
      const disabled = catalog.disabledEntries().find((e) => e.modelId === modelId);
      // Only an override (active or disabled) is an actual ModelCatalogEntry row;
      // an untouched shipped entry has nothing to delete.
      const existingRow = active?.origin === "override" ? active : disabled;
      if (!existingRow) {
        throw new McpError(
          404,
          `No catalog row for "${modelId}" to reset (it is either unmodified shipped, or unknown).`,
        );
      }
      const before = entryOf(existingRow);
      await ctx.db.modelCatalogEntry.deleteMany({ where: { modelId } });

      await deps.refresh?.();
      const updated = currentModelCatalog();
      const now = updated.get(modelId);
      audit(ctx, "reset", {
        provider: existingRow.provider,
        modelId,
        sourceUrl: existingRow.sourceUrl,
        before,
        after: now ? entryOf(now) : null,
      });

      const llm = ctx.providers.llm as RoutingLlmProvider;
      return textResult({ reset: modelId, now: now ? view(now, llm) : null });
    },
  });
}
