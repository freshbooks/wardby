import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition, type ResolvedCodingService } from "../../coding/services/catalog.js";
import { DockerJobLauncher } from "./docker.js";
import { isolationNames } from "./docker-isolation.js";
import { dockerServiceContainerNames } from "./docker-services.js";
import type { JobSpec } from "./types.js";

const execute = promisify(execFile);
const enabled = process.env.WARDBY_DOCKER_SERVICES_TEST === "1";
const image = process.env.WARDBY_DOCKER_SERVICES_FIXTURE_IMAGE ?? "";
const proxy = `wardby-services-proxy-${process.pid}-${Date.now()}`;
const POSTGRES = resolvedFromDefinition(
  BUILTIN_CODING_SERVICES.find((service) => service.name === "postgres" && service.version === "16")!,
);
const RUN_IDS = ["docker-services-smoke", "docker-services-unready"];
const roots: string[] = [];

async function docker(args: string[]): Promise<string> {
  const result = await execute("docker", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

function runFilters(runId: string): string[] {
  return [
    "--filter",
    "label=io.wardby.managed=true",
    "--filter",
    `label=io.wardby.run-sha256=${createHash("sha256").update(runId).digest("hex")}`,
  ];
}

/** Every managed container, network and volume still labelled for this run. */
async function leftovers(runId: string): Promise<string[]> {
  const listed = await Promise.all([
    docker(["container", "ls", "--all", "--quiet", ...runFilters(runId)]),
    docker(["network", "ls", "--quiet", ...runFilters(runId)]),
    docker(["volume", "ls", "--quiet", ...runFilters(runId)]),
  ]);
  return listed.join("\n").split("\n").filter(Boolean);
}

/** Removes only what this test's runs labelled, so an interrupted run never leaks into the next. */
async function sweep(runId: string): Promise<void> {
  const quiet = async (args: string[]) => docker(args).catch(() => "");
  const lines = (output: string) => output.split("\n").filter(Boolean);
  for (const container of lines(await quiet(["container", "ls", "--all", "--quiet", ...runFilters(runId)]))) {
    await quiet(["container", "rm", "--force", "--volumes", container]);
  }
  await quiet(["network", "disconnect", "--force", isolationNames(runId).network, proxy]);
  for (const network of lines(await quiet(["network", "ls", "--quiet", ...runFilters(runId)]))) {
    await quiet(["network", "rm", network]);
  }
  for (const volume of lines(await quiet(["volume", "ls", "--quiet", ...runFilters(runId)]))) {
    await quiet(["volume", "rm", "--force", volume]);
  }
}

interface Inspection {
  Id: string;
  HostConfig: { NetworkMode?: string; Tmpfs?: Record<string, string> };
  NetworkSettings?: { Networks?: Record<string, unknown> };
  Mounts?: { Type?: string }[];
}

async function inspect(name: string): Promise<Inspection> {
  return (JSON.parse(await docker(["container", "inspect", name])) as Inspection[])[0];
}

async function setup(runId: string, services: ResolvedCodingService[]) {
  const root = await mkdtemp(join(tmpdir(), "wardby-docker-services-"));
  roots.push(root);
  const workspace = join(root, "workspaces", runId, "workspace");
  const git = join(root, "workspaces", runId, "git");
  const input = join(root, "input.json");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(git, { recursive: true })]);
  await Promise.all([
    writeFile(join(workspace, "README.md"), "fixture\n"),
    writeFile(join(git, "HEAD"), "ref: refs/heads/main\n"),
    writeFile(input, "{}"),
  ]);
  const launcher = new DockerJobLauncher({
    stateRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    proxyContainer: proxy,
    resolveCapability: async () => "rrp_0123456789abcdef",
    isRunActive: async () => false,
  });
  const spec: JobSpec = {
    kind: "coding-agent",
    runId,
    image,
    inputArtifact: input,
    timeoutSec: 300,
    limits: { cpus: 0.5, memoryMb: 256, pids: 64, diskMb: 64 },
    labels: {},
    services,
  };
  return { launcher, spec };
}

describe.skipIf(!enabled || !image)("Docker launcher services smoke", () => {
  beforeAll(async () => {
    for (const runId of RUN_IDS) await sweep(runId);
    await docker([
      "container",
      "create",
      "--name",
      proxy,
      "--network",
      "bridge",
      "--entrypoint",
      "node",
      image,
      "-e",
      "require('node:http').createServer((_,r)=>r.end('ok')).listen(8787,'0.0.0.0')",
    ]);
    await docker(["container", "start", proxy]);
  }, 60_000);

  afterAll(async () => {
    for (const runId of RUN_IDS) await sweep(runId);
    await docker(["container", "rm", "--force", proxy]).catch(() => undefined);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }, 60_000);

  it("runs postgres in the worker's namespace, keeps the proxy reachable, and removes everything", async () => {
    const { launcher, spec } = await setup("docker-services-smoke", [POSTGRES]);
    const handle = await launcher.launch(spec);
    let status = await launcher.status(handle);
    for (let attempt = 0; attempt < 600 && (status.state === "pending" || status.state === "running"); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      status = await launcher.status(handle);
    }
    expect(status).toEqual({ state: "succeeded" });
    expect(await launcher.collect(handle)).toMatchObject({ reason: "completed" });

    // The worker shares the network keeper's namespace and owns no network of its own.
    const keeperName = isolationNames(spec.runId).networkKeeperContainer;
    const keeper = await inspect(keeperName);
    const worker = await inspect(handle.id);
    const mode = worker.HostConfig.NetworkMode;
    expect([`container:${keeperName}`, `container:${keeper.Id}`]).toContain(mode);
    expect(Object.keys(worker.NetworkSettings?.Networks ?? {})).toEqual([]);
    console.info(`worker NetworkMode reported by keeper ${mode === `container:${keeperName}` ? "name" : "full id"}`);

    // --tmpfs at the data path suppresses the postgres image's anonymous VOLUME.
    const [serviceName] = dockerServiceContainerNames(spec);
    const service = await inspect(serviceName);
    expect(service.HostConfig.Tmpfs).toHaveProperty(POSTGRES.dataPath);
    expect((service.Mounts ?? []).filter((mount) => mount.Type === "volume")).toEqual([]);

    await launcher.remove(handle);
    expect(await leftovers(spec.runId)).toEqual([]);
  }, 300_000);

  it("fails as coding_service_unready and leaves nothing behind when readiness never passes", async () => {
    const broken = {
      ...POSTGRES,
      readiness: { command: ["false"], periodSeconds: 1, timeoutSeconds: 2, failureThreshold: 2 },
    };
    const { launcher, spec } = await setup("docker-services-unready", [broken]);
    await expect(launcher.launch(spec)).rejects.toThrow("coding_service_unready:postgres");
    expect(await leftovers(spec.runId)).toEqual([]);
  }, 300_000);
});
