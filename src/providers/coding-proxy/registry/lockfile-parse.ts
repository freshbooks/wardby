/**
 * Parses a lockfile in a disposable worker thread with a hard time bound,
 * for the formats that are costly to read (pnpm's and yarn's: YAML, or
 * yarn classic's own format). A lockfile is attacker-controlled up to the
 * 20 MiB plan cap, and a synchronous parse can't be interrupted, so on the
 * event loop a crafted one could stall every request the proxy serves (model
 * traffic included) for seconds. A worker's terminate() can stop it; the
 * event loop only deserializes the bounded result (entries and their edges).
 *
 * One worker per parse, never reused (the same choice as the sandbox's
 * parser pool): plans already run at most `planConcurrency` at once.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { RegistryError, type LockfileEntry, type ParsedLockfile } from "../../../coding/registry/types.js";
import type { ParseRequest, ParseResponse, ShippedLockfile } from "./lockfile-parse-worker.js";

/** Time one off-thread lockfile parse may take. Real lockfiles at the
 *  entry bound parse in well under a second. */
export const DEFAULT_LOCKFILE_PARSE_TIMEOUT_MS = 15_000;
/** Heap one parse worker may use before it is stopped (a crafted lockfile
 *  that expands while parsing). */
const PARSE_WORKER_MAX_OLD_GEN_MB = 512;

const compiledWorker = new URL("./lockfile-parse-worker.js", import.meta.url);
// Under tsx/vitest only the .ts source exists, and a worker gets no TS
// loader by inheritance (see src/sandbox/parser-worker/pool.ts).
const WORKER_URL = existsSync(fileURLToPath(compiledWorker))
  ? compiledWorker
  : new URL("./lockfile-parse-worker.ts", import.meta.url);
const WORKER_EXEC_ARGV = WORKER_URL.pathname.endsWith(".ts") ? ["--import", "tsx/esm"] : [];

function incomplete(message: string): RegistryError {
  return new RegistryError(503, "wardby_plan_incomplete", message);
}

/** The ParsedLockfile a worker shipped back, with `resolve` answering from
 *  its edge table. */
function rebuild(shipped: ShippedLockfile): ParsedLockfile {
  const byPath = new Map<string, Map<string, LockfileEntry>>();
  shipped.entries.forEach((entry, at) => {
    byPath.set(entry.path, new Map(shipped.edges[at].map(([key, target]) => [key, shipped.entries[target]])));
  });
  return {
    entries: shipped.entries,
    projects: shipped.projects,
    ...(shipped.integrity ? { integrity: shipped.integrity } : {}),
    resolve: (fromPath, key) => byPath.get(fromPath)?.get(key),
    dependencyKeys: (path) => [...(byPath.get(path)?.keys() ?? [])],
  };
}

export async function parseLockfileOffThread(
  ecosystem: string,
  body: string,
  options: { maxEntries: number; proxyRegistryUrl: string },
  limits: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ParsedLockfile> {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_LOCKFILE_PARSE_TIMEOUT_MS;
  if (limits.signal?.aborted) throw incomplete("the client went away before the lockfile was read");
  const worker = new Worker(WORKER_URL, {
    resourceLimits: { maxOldGenerationSizeMb: PARSE_WORKER_MAX_OLD_GEN_MB },
    execArgv: WORKER_EXEC_ARGV,
  });
  try {
    const response = await new Promise<ParseResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(incomplete(`the lockfile was not read within ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      );
      const onAbort = () => reject(incomplete("the client went away before the lockfile was read"));
      limits.signal?.addEventListener("abort", onAbort, { once: true });
      const settle = () => {
        clearTimeout(timer);
        limits.signal?.removeEventListener("abort", onAbort);
      };
      worker.once("message", (message: ParseResponse) => {
        settle();
        resolve(message);
      });
      worker.once("error", (error: Error) => {
        settle();
        // Out of heap is the common case: the lockfile expanded too far.
        reject(
          new RegistryError(413, "wardby_lockfile_too_large", `the lockfile could not be read (${error.message})`),
        );
      });
      worker.once("exit", (code) => {
        settle();
        reject(new RegistryError(413, "wardby_lockfile_too_large", `the lockfile reader stopped (exit code ${code})`));
      });
      const request: ParseRequest = { ecosystem, body, ...options };
      worker.postMessage(request);
    });
    if (!response.ok) throw new RegistryError(response.status, response.code, response.message);
    return rebuild(response.lockfile);
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
