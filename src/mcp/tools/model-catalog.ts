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
 * Correctness of a write never depends on the process's installed
 * CatalogStore, which can be stale (it polls on an interval) or briefly
 * unreachable:
 *  - `set_model`'s provider-conflict check reads `ctx.db` directly (plus the
 *    static shipped catalog, which is never stale), not the in-memory
 *    catalog — a conflicting row written by another process/replica and
 *    not yet polled in here must still be caught.
 *  - Every write's response and audit event are built from the data just
 *    written (what we know is true), never from a post-write re-read of the
 *    catalog — so a refresh failure can never turn a successful write into
 *    an unaudited one, or into an error.
 *  - `deps.refresh` is still called best-effort after each write (so this
 *    process's own routing picks up the change promptly); a failure is
 *    logged and swallowed, never thrown.
 *  - `set_model` additionally re-checks ownership after a *successful*
 *    refresh: two processes racing to claim the same model id under
 *    different providers can both write (the compound key is
 *    (provider, modelId), not modelId alone) — `buildCatalog` then silently
 *    picks one winner. If the merge didn't pick us, we report an error
 *    rather than success, even though our own row did get written.
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
  sameEntry,
  type CatalogEntry,
  type CatalogRow,
  type ResolvedCatalogEntry,
} from "../../providers/llm/catalog-types.js";
import { LLM_EFFORT_LEVELS } from "../../providers/llm/types.js";
import { rowFromRecord } from "../../providers/llm/catalog.js";
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
    /** Every provider whose row was touched (reset_model can, in principle, clear more than one). Omitted when it's just `provider`. */
    providers?: string[];
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
      ...(info.providers && info.providers.length > 1 ? { providers: info.providers } : {}),
      modelId: info.modelId,
      sourceUrl: info.sourceUrl,
      before: info.before,
      after: info.after,
      by: ctx.principal.id,
    },
    "model catalog changed",
  );
}

/** Best-effort: logs and swallows a refresh failure rather than letting it fail (or un-audit) an already-committed write. Returns whether it actually ran and succeeded. */
async function refreshBestEffort(
  refresh: (() => Promise<void>) | undefined,
  context: Record<string, unknown>,
): Promise<boolean> {
  if (!refresh) return false;
  try {
    await refresh();
    return true;
  } catch (err) {
    modelsLog.warn(
      { event: "models.catalog.refresh_failed", ...context, err: err instanceof Error ? err.message : String(err) },
      "model catalog refresh failed after a write; the write stands, but routing may lag until the next poll",
    );
    return false;
  }
}

function conflictError(modelId: string, provider: string, enabled: boolean): McpError {
  return enabled
    ? new McpError(409, `Model "${modelId}" is already served by provider "${provider}"; reset or disable it first.`)
    : new McpError(
        409,
        `Model "${modelId}" is reserved by a disabled entry for provider "${provider}"; reset_model it first.`,
      );
}

/**
 * Mirrors buildCatalog's own ownership rule (catalog.ts) exactly, from the raw
 * rows a conflict check reads: for a model id the shipped catalog has, the
 * shipped provider ALWAYS owns it — buildCatalog seeds ownership from the
 * shipped provider before any row is even considered, so any row for that id
 * under a different provider is a dead orphan it permanently skips, no
 * matter how many such rows accumulate or what their timestamps are. For a
 * model id the shipped catalog doesn't have, the earliest-updated row's
 * provider owns it (ties broken by provider name), exactly as buildCatalog's
 * ascending-updatedAt sort + first-claim logic resolves it. A disabled row
 * still reserves the id for its provider; the shipped provider with no row
 * at all is implicitly "enabled" (it's just the untouched shipped entry).
 * Returns null only for a model id that is neither shipped nor ever written.
 */
function catalogOwner(
  shippedEntry: CatalogEntry | undefined,
  rows: readonly { provider: string; enabled: boolean; updatedAt: unknown }[],
): { provider: string; enabled: boolean } | null {
  if (shippedEntry) {
    const ownRow = rows.find((row) => row.provider === shippedEntry.provider);
    return { provider: shippedEntry.provider, enabled: ownRow ? ownRow.enabled : true };
  }
  if (rows.length === 0) return null;
  const updatedAtMs = (row: { updatedAt: unknown }) =>
    row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(String(row.updatedAt)).getTime();
  const [earliest] = [...rows].sort((a, b) => updatedAtMs(a) - updatedAtMs(b) || a.provider.localeCompare(b.provider));
  return { provider: earliest.provider, enabled: earliest.enabled };
}

/**
 * The post-write ownership-race error: our own row for `inputProvider` was
 * written, but a refresh right after showed `nowOwner` winning the merge
 * instead (buildCatalog's first-claim-wins rule — see `catalogOwner`). Named
 * after the thing that actually fixes it (reset_model, which clears every
 * row for the id, `nowOwner`'s included) rather than telling the caller to
 * "retry set_model", which would just hit the pre-write conflict check again
 * (or, if the race repeats, loop). Exported so its exact wording can be unit
 * tested directly — forcing the genuine two-process write race that triggers
 * this through the public tool-call surface isn't practical: it requires a
 * competing write to land in the narrow window between this handler's own
 * pre-write ownership check and its own write, which a single-process test
 * harness has no way to inject mid-call.
 */
export function raceLostError(modelId: string, inputProvider: string, nowOwner: string): McpError {
  return new McpError(
    409,
    `Model "${modelId}" was written for provider "${inputProvider}" but is not serving it: provider "${nowOwner}" ` +
      `owns it in the merged catalog. reset_model removes every row for "${modelId}" (including "${nowOwner}"'s); ` +
      `set_model can then claim it for "${inputProvider}".`,
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
      const { sourceUrl, ...entry } = input;

      // Ownership is checked against the database directly, not the process's
      // (possibly stale, poll-interval-old) installed catalog: a row written
      // by another process/replica must be caught even if this process
      // hasn't refreshed since. The static shipped catalog is never stale,
      // so it's safe to read from the in-memory catalog either way. The
      // check itself mirrors buildCatalog's merge rule exactly (catalogOwner)
      // rather than "any different-provider row blocks": for a shipped id,
      // an orphaned other-provider row (dead in the merge no matter what) must
      // not falsely block the true (shipped) owner, and must not be let through
      // just because it happens to share its own provider with input.provider.
      const existingRows = await ctx.db.modelCatalogEntry.findMany({ where: { modelId: input.modelId } });
      const shippedEntry = currentModelCatalog().shippedEntry(input.modelId);
      const owner = catalogOwner(shippedEntry, existingRows);
      if (owner && owner.provider !== input.provider) {
        throw conflictError(input.modelId, owner.provider, owner.enabled);
      }

      const ownRow = existingRows.find((row) => row.provider === input.provider);
      const parsedOwnRow = ownRow ? rowFromRecord(ownRow) : null;
      const before: CatalogEntry | null = parsedOwnRow
        ? entryOf(parsedOwnRow)
        : shippedEntry && shippedEntry.provider === input.provider
          ? entryOf(shippedEntry)
          : null;

      const data = { ...entry, efforts: [...entry.efforts], enabled: true, sourceUrl, updatedBy: ctx.principal.id };
      const row = await ctx.db.modelCatalogEntry.upsert({
        where: { provider_modelId: { provider: input.provider, modelId: input.modelId } },
        create: data,
        update: data,
      });

      // Audited from the data we know was written — independent of whether
      // the refresh below succeeds, so a transient refresh failure can
      // never leave a committed write un-audited.
      const after = entryOf(entry);
      audit(ctx, "set", { provider: input.provider, modelId: input.modelId, sourceUrl, before, after });

      const warnings = RATE_FIELDS.filter((field) => input[field] === 0).map(
        (field) => `${field} is 0: confirm against ${sourceUrl}`,
      );

      const refreshed = await refreshBestEffort(deps.refresh, { action: "set", modelId: input.modelId });

      // Two processes racing to claim the same id under different providers
      // can both write (the unique key is (provider, modelId), not modelId
      // alone); buildCatalog then silently picks one winner. If a refresh
      // just told us the merge didn't pick us, our own row is dead on
      // arrival — report an error rather than success.
      if (refreshed) {
        const nowOwner = currentModelCatalog().get(input.modelId)?.provider;
        if (nowOwner && nowOwner !== input.provider) {
          throw raceLostError(input.modelId, input.provider, nowOwner);
        }
      }

      const llm = ctx.providers.llm as RoutingLlmProvider;
      const resolved: ResolvedCatalogEntry = {
        ...entry,
        origin: "override",
        priceVersion: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date().toISOString(),
        sourceUrl,
        updatedBy: ctx.principal.id,
        ...(shippedEntry ? { shippedDiffers: !sameEntry(shippedEntry, entry) } : {}),
      };
      return textResult({ model: view(resolved, llm), warnings });
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
        ...before,
        efforts: [...before.efforts],
        enabled: false,
        sourceUrl,
        updatedBy: ctx.principal.id,
      };
      const row = await ctx.db.modelCatalogEntry.upsert({
        where: { provider_modelId: { provider: active.provider, modelId } },
        create: data,
        update: data,
      });

      // Disabling never changes the core CatalogEntry fields, so "after" is
      // "before" — audited from the write we just made, not a post-refresh
      // re-read, same reasoning as set_model.
      const after = before;
      audit(ctx, "disable", { provider: active.provider, modelId, sourceUrl, before, after });

      await refreshBestEffort(deps.refresh, { action: "disable", modelId });

      const llm = ctx.providers.llm as RoutingLlmProvider;
      const shippedEntry = catalog.shippedEntry(modelId);
      const resolved: ResolvedCatalogEntry = {
        ...before,
        origin: "override",
        priceVersion: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date().toISOString(),
        sourceUrl,
        updatedBy: ctx.principal.id,
        ...(shippedEntry ? { shippedDiffers: !sameEntry(shippedEntry, before) } : {}),
      };
      return textResult({ disabled: view(resolved, llm) });
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

      // The 404 decision and the audited `providers` list are both based on
      // the RAW rows, not rows that parse cleanly through rowFromRecord: a
      // row can be malformed (fails parsing) yet still exist and still
      // occupy the id. Deciding "nothing to reset" or omitting a provider
      // from the audit based on parse success would delete a malformed row
      // silently and leave the id permanently stuck — set_model's
      // DB-sourced conflict check would keep seeing it (via catalogOwner)
      // and refusing every provider forever, with no tool able to clear it.
      const rawRows = await ctx.db.modelCatalogEntry.findMany({ where: { modelId } });
      if (rawRows.length === 0) {
        throw new McpError(
          404,
          `No catalog row for "${modelId}" to reset (it is either unmodified shipped, or unknown).`,
        );
      }
      const providers = [...new Set(rawRows.map((row) => String(row.provider)))];
      const parsedRows = rawRows.map((row) => rowFromRecord(row)).filter((row): row is CatalogRow => row !== null);
      const before = parsedRows.length > 0 ? entryOf(parsedRows[0]) : null;
      const sourceUrl = parsedRows[0]?.sourceUrl;
      await ctx.db.modelCatalogEntry.deleteMany({ where: { modelId } });

      // The shipped entry is static (compiled-in), never stale, so "after"
      // and the response's "now" can both be built from it directly,
      // without depending on the refresh below at all.
      const shippedEntry = currentModelCatalog().shippedEntry(modelId);
      const after = shippedEntry ? entryOf(shippedEntry) : null;
      audit(ctx, "reset", { provider: providers[0], providers, modelId, sourceUrl, before, after });

      await refreshBestEffort(deps.refresh, { action: "reset", modelId });

      const llm = ctx.providers.llm as RoutingLlmProvider;
      const now = shippedEntry
        ? view({ ...shippedEntry, origin: "shipped", priceVersion: `shipped:${SHIPPED_CATALOG_VERSION}` }, llm)
        : null;
      return textResult({ reset: modelId, now });
    },
  });
}
