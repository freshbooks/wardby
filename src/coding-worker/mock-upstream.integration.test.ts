// Drives the real Codex SDK (the pinned binary, not a fake client) through
// runCodingWorker (driver.ts) against a local HTTP server standing in for the
// coding proxy's /v1/responses endpoint. That server answers every request
// with Task 1's load-test mock upstream (createMockUpstream), proving the
// mock's streamed Responses shape is one the real Codex SDK accepts end to
// end -- not just one the mock's own unit tests accept. Skipped when the
// platform's Codex binary isn't installed (npm installs only the host's
// optional dependency), the same condition codex-compatibility.test.ts uses.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingTaskInput } from "../coding/protocol.js";
import { createMockUpstream } from "../providers/coding-proxy/mock-upstream.js";
import { writeCodingOutputAtomic } from "./artifact.js";
import { runCodingWorker } from "./driver.js";
import { createCodexSdkClient } from "./sdk.js";
import type { WorkerClientFactory } from "./types.js";

const require = createRequire(import.meta.url);

function codexBinaryInstalled(): boolean {
  try {
    require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

describe.skipIf(!codexBinaryInstalled())("real Codex worker through the mock upstream", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) await task();
  });

  it("finishes no_changes for the real run id, with exactly one model request", async () => {
    const requests: string[] = [];
    const mockFetch = createMockUpstream({ latencyMs: 0 });
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body = await readBody(request);
        requests.push(body);
        const upstreamResponse = await mockFetch("https://api.openai.com/v1/responses", { method: "POST", body });
        const headers: Record<string, string> = {};
        upstreamResponse.headers.forEach((value, key) => {
          headers[key] = value;
        });
        response.writeHead(upstreamResponse.status, headers);
        response.end(await upstreamResponse.text());
      })().catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500).end();
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    const root = await mkdtemp(join(tmpdir(), "wardby-mock-upstream-integration-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });

    // runCodingWorker's own environment (driver.ts's workerEnvironment) hardcodes
    // HOME to the worker container's "/home/wardby", which does not exist on a
    // local dev machine. createClient is the sanctioned seam (driver.test.ts
    // substitutes a fake client through it the same way) for swapping in a
    // writable local HOME before handing the config to the real Codex SDK
    // adapter; everything else -- prompt, schema, sandboxing, proxy base URL --
    // still goes through the production runCodingWorker code path unchanged.
    const createClient: WorkerClientFactory = (config) =>
      createCodexSdkClient({ ...config, environment: { ...config.environment, HOME: home } });

    const input: CodingTaskInput = {
      schemaVersion: 1,
      runId: "run_mock_integration_1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "wardby/run-run_mock_integration_1",
      task: "Add hello.txt",
      model: "gpt-5.6-terra",
      budgetUsd: 1,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    };

    const output = await runCodingWorker({
      input,
      workspace,
      proxyBaseUrl: `http://127.0.0.1:${port}`,
      capability: "mock-upstream-integration-capability",
      signal: AbortSignal.timeout(90_000),
      createClient,
    });

    expect(output.outcome).toBe("no_changes");
    expect(output.runId).toBe(input.runId);
    expect(requests).toHaveLength(1);

    const outputPath = join(root, "output", "result.json");
    await writeCodingOutputAtomic(outputPath, output);
    const written = JSON.parse(await readFile(outputPath, "utf8")) as { outcome: string; runId: string };
    expect(written.outcome).toBe("no_changes");
    expect(written.runId).toBe(input.runId);
  }, 120_000);
});
