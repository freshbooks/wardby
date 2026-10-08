/**
 * The worker side of the native sandbox contract: runs the unchanged
 * NativeEngine with an EngineRunContext whose every outside effect is a
 * gateway call. User tools run here, in QuickJS, with their privileged
 * bridges (fetch, datastore, secrets, console) served by the gateway; built-in
 * tools run on the gateway. Worker-safe: no database, provider adapter, or
 * credential is reachable from this module's imports (worker-imports.test.ts).
 */

import { NativeEngine } from "../core/engine-native.js";
import type { EngineRunContext } from "../providers/engine/types.js";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import { computeCost } from "../providers/llm/pricing-core.js";
import { PRIVILEGED_BRIDGE_NAMES, type PrivilegedHost } from "../sandbox/host-functions.js";
import { runUserToolCall } from "../sandbox/user-tool.js";
import {
  GatewayError,
  NATIVE_WORKER_PROTOCOL_VERSION,
  type GatewayMethod,
  type GatewayParams,
  type GatewayRequest,
  type WorkerInput,
} from "./protocol.js";

/** How the worker reaches the gateway. Errors arrive as GatewayError. */
export interface GatewayTransport {
  call(request: GatewayRequest): Promise<unknown>;
  stream(request: GatewayRequest): AsyncIterable<LlmStreamEvent>;
}

/** Runs one native run to its result and reports it with `finish`. Resolves when done. */
export async function runNativeWorker(input: WorkerInput, transport: GatewayTransport): Promise<void> {
  let sequence = 0;
  const nextCallId = (kind: string) => `${kind}-${++sequence}`;
  const request = <M extends GatewayMethod>(method: M, params: GatewayParams<M>): GatewayRequest => ({
    v: NATIVE_WORKER_PROTOCOL_VERSION,
    runId: input.runId,
    callId: nextCallId(method),
    method,
    params,
  });
  const call = <M extends GatewayMethod>(method: M, params: GatewayParams<M>) =>
    transport.call(request(method, params));

  const llm: LlmProvider = {
    stream: (req) => transport.stream(request("llm.stream", { request: req })),
    countTokens: async (model, messages, tools) =>
      (await call("llm.countTokens", {
        model,
        messages: messages,
        ...(tools ? { tools } : {}),
      })) as number,
    // Local and exact: the run's pinned entry, the same computeCost the gateway's adapters use.
    priceUsd: (_model, usage) => computeCost(input.pricing, usage),
  };

  const builtins = new Set(input.builtinTools);
  let invocations = 0;
  const remoteHost = (tool: string): PrivilegedHost => {
    const invocation = `t${++invocations}`;
    return Object.fromEntries(
      PRIVILEGED_BRIDGE_NAMES.map((bridge) => [
        bridge,
        async (argsJson: string) => {
          try {
            return await call("host.call", { tool, invocation, bridge, argsJson });
          } catch (err) {
            // A bridge failure reaches the tool as the same error message it would see in-process.
            if (err instanceof GatewayError && err.code === "bridge_error")
              throw new Error(err.message, { cause: err });
            throw err;
          }
        },
      ]),
    ) as PrivilegedHost;
  };

  const runSandboxTool = async (name: string, argsJson: string): Promise<string> => {
    if (builtins.has(name)) return (await call("builtin.call", { name, argsJson })) as string;
    const tool = input.userTools[name];
    if (!tool) {
      return JSON.stringify({ error: "unknown_tool", message: `No tool named "${name}" is attached to this agent.` });
    }
    const host = remoteHost(name);
    return runUserToolCall(tool, argsJson, () => host);
  };

  let textSeq = 0;
  const concurrent = new Set(input.runsConcurrently);
  const ctx: EngineRunContext = {
    agent: input.agent,
    tools: input.tools,
    providers: { llm },
    runSandboxTool,
    ...(concurrent.size > 0 ? { runsConcurrently: (toolName: string) => concurrent.has(toolName) } : {}),
    onText: (delta) => {
      void call("text", { seq: textSeq++, delta }).catch(() => {
        // Streamed text is for live observers only; the final text travels with `finish`.
      });
    },
    onProgress: async (progress) => {
      await call("progress", { turns: progress.turns, usage: progress.usage });
    },
  };

  const result = await new NativeEngine().run(ctx);
  await call("finish", {
    status: result.status,
    finalText: result.finalText,
    turns: result.turns,
    ...(result.error !== undefined ? { error: result.error } : {}),
  });
}
