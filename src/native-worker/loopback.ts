/**
 * The in-process harness transport: the worker and gateway in one process,
 * with every message (worker input, requests, results, stream events, errors)
 * forced through a JSON round trip so nothing crosses by reference — the same
 * shape a real transport has. For tests and local development; never a
 * sandbox (the worker runs in the server's own process).
 */

import type { LlmStreamEvent } from "../providers/llm/types.js";
import type { NativeGateway, WorkerLauncher } from "./gateway.js";
import { GatewayError, parseMessage, WorkerInputSchema, type GatewayRequest } from "./protocol.js";
import { runNativeWorker, type GatewayTransport } from "./worker.js";

const wire = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

function asGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return new GatewayError(err.code, err.message);
  return new GatewayError("internal", err instanceof Error ? err.message : String(err));
}

export function createLoopbackTransport(gateway: NativeGateway): GatewayTransport {
  return {
    async call(request: GatewayRequest) {
      try {
        return wire(await gateway.call(wire(request)));
      } catch (err) {
        throw asGatewayError(err);
      }
    },
    async *stream(request: GatewayRequest): AsyncIterable<LlmStreamEvent> {
      try {
        for await (const event of gateway.stream(wire(request))) yield wire(event);
      } catch (err) {
        throw asGatewayError(err);
      }
    },
  };
}

/** Runs the worker in this process over the loopback transport. */
export const loopbackLauncher: WorkerLauncher = {
  async run(input, gateway) {
    try {
      const parsed = parseMessage(JSON.stringify(input), WorkerInputSchema);
      await runNativeWorker(parsed, createLoopbackTransport(gateway));
      return { exitCode: 0 };
    } catch {
      return { exitCode: 1 };
    }
  },
};
