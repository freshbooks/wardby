import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertToolRunnerReachable } from "./tool-socket.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function socketDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wardby-tool-socket-"));
  roots.push(root);
  return root;
}

describe("assertToolRunnerReachable", () => {
  it("resolves when the tool runner is listening", async () => {
    const path = join(await socketDir(), "runner.sock");
    const server = createServer((socket) => socket.end());
    servers.push(server);
    await new Promise<void>((done) => server.listen(path, done));
    await expect(assertToolRunnerReachable(path)).resolves.toBeUndefined();
  });

  it("fails by name when the socket is absent", async () => {
    const path = join(await socketDir(), "runner.sock");
    await expect(assertToolRunnerReachable(path)).rejects.toThrow("worker_tool_runner_unreachable");
  });
});
