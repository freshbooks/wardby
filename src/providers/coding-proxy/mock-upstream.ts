/**
 * A fake model upstream for load tests: a `fetch` that never opens a socket.
 * It answers an OpenAI Responses streaming request with one assistant message
 * whose text is the coding worker's final JSON (`outcome: "no_changes"`), so a
 * run finishes without tool calls, changes or a pull request. Enabled only by
 * `mockUpstreamFromEnv` (see its guard). Never use outside a load test.
 *
 * Codex/OpenAI Responses only (ruling R1): any other host, including the
 * Anthropic Messages endpoint, gets a 501 rather than a fabricated reply.
 */
export interface MockUpstreamConfig {
  latencyMs: number;
  jitterMs: number;
  inputTokens: number;
  outputTokens: number;
}

export const DEFAULT_MOCK_UPSTREAM: MockUpstreamConfig = {
  latencyMs: 5000,
  jitterMs: 0,
  inputTokens: 1200,
  outputTokens: 80,
};

const RUN_ID = /The final JSON runId must be ([A-Za-z0-9][A-Za-z0-9_-]*)\./;

/** The runId the coding worker's prompt names, or null when the request carries none. */
export function extractRunId(body: string): string | null {
  return RUN_ID.exec(body)?.[1] ?? null;
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function bodyText(input: string | URL | Request, init: RequestInit | undefined): Promise<string> {
  const raw = init?.body;
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
  if (input instanceof Request) return input.text();
  return "";
}

/**
 * Builds a `fetch` that simulates the OpenAI Responses streaming endpoint for
 * load tests: no socket, no credential forwarding, deterministic latency and
 * token counts. `sleep` is injectable so tests can assert on the delay without
 * waiting it out.
 */
export function createMockUpstream(
  overrides: Partial<MockUpstreamConfig> = {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): typeof globalThis.fetch {
  const config = { ...DEFAULT_MOCK_UPSTREAM, ...overrides };
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "api.openai.com") {
      return Response.json({ error: { code: "mock_upstream_protocol_unsupported" } }, { status: 501 });
    }
    const runId = extractRunId(await bodyText(input, init));
    if (!runId) return Response.json({ error: { code: "mock_upstream_no_run_id" } }, { status: 400 });

    await sleep(config.latencyMs + Math.floor(Math.random() * (config.jitterMs + 1)));

    const text = JSON.stringify({
      schemaVersion: 1,
      runId,
      outcome: "no_changes",
      summary: "Load test: no changes.",
      tag: null,
      tests: [],
    });
    const id = `resp_mock_${runId}`;
    const item = {
      id: `msg_${runId}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const usage = {
      input_tokens: config.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: config.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: config.inputTokens + config.outputTokens,
    };
    const stream =
      sse("response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }) +
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      }) +
      sse("response.output_text.delta", {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: text,
      }) +
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
      sse("response.completed", {
        type: "response.completed",
        response: { id, status: "completed", output: [item], usage },
      });

    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}
