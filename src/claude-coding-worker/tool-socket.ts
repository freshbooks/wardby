import { createConnection } from "node:net";

/** Where the tool runner listens (claude-tool-runner/main.mjs) and the relay connects (tool-relay.ts). */
export const TOOL_SOCKET_PATH = "/run/wardby/tool/runner.sock";

/**
 * Fails fast, by name, when the tool runner's socket can't be reached, before the model is called.
 * Without it the relay exits, Claude Code runs with no command tool, and the model can only report
 * that it could not run anything: a run that "succeeds" having done nothing. (Under gVisor, for one,
 * a socket bound on a volume the two containers don't share is simply absent from this side.)
 */
export async function assertToolRunnerReachable(socketPath = TOOL_SOCKET_PATH, timeoutMs = 5_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const fail = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("worker_tool_runner_unreachable"));
    };
    const timer = setTimeout(fail, timeoutMs);
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
  });
}
