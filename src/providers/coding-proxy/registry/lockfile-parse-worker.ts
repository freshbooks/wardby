/**
 * Runs inside a worker thread spawned by lockfile-parse.ts: parses one
 * lockfile with the ecosystem's own parser, off the proxy's event loop, and
 * posts back a plain, structured-cloneable form of the result (entries,
 * projects, and the edge table `resolve` answers from). `parentPort` is
 * null when this file is merely imported, so nothing runs then.
 */
import { parentPort } from "node:worker_threads";
import { REGISTRY_ADAPTERS } from "../../../coding/registry/adapters.js";
import { RegistryError, type ParsedLockfile } from "../../../coding/registry/types.js";

export interface ParseRequest {
  ecosystem: string;
  body: string;
  maxEntries: number;
  proxyRegistryUrl: string;
}

/** A ParsedLockfile without its functions: `edges[i]` lists, for
 *  `entries[i]`, each dependency key the lockfile records that resolves to
 *  an entry, with that entry's index. */
export interface ShippedLockfile {
  entries: ParsedLockfile["entries"];
  projects: ParsedLockfile["projects"];
  integrity?: ParsedLockfile["integrity"];
  edges: [key: string, target: number][][];
}

export type ParseResponse =
  { ok: true; lockfile: ShippedLockfile } | { ok: false; status: number; code: string; message: string };

/** At most this many edges per entry are shipped (far above any real
 *  package's dependency count), so a crafted entry with a huge dependency
 *  map can't make the main thread deserialize millions of them. */
const MAX_EDGES_PER_ENTRY = 2000;

export function parseAndShip(request: ParseRequest): ShippedLockfile {
  const support = REGISTRY_ADAPTERS.get(request.ecosystem)?.lockfilePlan;
  if (!support) throw new RegistryError(404, "wardby_plan_unsupported", `no lockfile plans for ${request.ecosystem}`);
  const parsed = support.parse(request.body, {
    maxEntries: request.maxEntries,
    proxyRegistryUrl: request.proxyRegistryUrl,
  });
  if (!parsed.dependencyKeys) throw new Error("this lockfile format cannot be parsed off the event loop");
  const index = new Map(parsed.entries.map((entry, at) => [entry, at]));
  const edges = parsed.entries.map((entry) => {
    const keys = parsed.dependencyKeys!(entry.path);
    if (keys.length > MAX_EDGES_PER_ENTRY)
      throw new RegistryError(
        413,
        "wardby_lockfile_too_large",
        `lockfile entry "${entry.path}" lists ${keys.length} dependencies; at most ${MAX_EDGES_PER_ENTRY} are read`,
      );
    const out: [string, number][] = [];
    for (const key of keys) {
      const target = parsed.resolve(entry.path, key);
      const at = target && index.get(target);
      if (at !== undefined && at !== null) out.push([key, at]);
    }
    return out;
  });
  return {
    entries: parsed.entries,
    projects: parsed.projects,
    ...(parsed.integrity ? { integrity: parsed.integrity } : {}),
    edges,
  };
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (request: ParseRequest) => {
    let response: ParseResponse;
    try {
      response = { ok: true, lockfile: parseAndShip(request) };
    } catch (error) {
      response =
        error instanceof RegistryError
          ? { ok: false, status: error.status, code: error.code, message: error.message }
          : { ok: false, status: 400, code: "wardby_bad_request", message: "the lockfile could not be read" };
    }
    port.postMessage(response);
  });
}
