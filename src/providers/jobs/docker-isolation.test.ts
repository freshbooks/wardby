import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertDockerHostSupportsIsolation,
  assertClaudeToolRunnerContainerInspection,
  assertIsolationNetworkInspection,
  assertNetworkKeeperContainerInspection,
  buildClaudeAgentCreateArgs,
  buildClaudeToolRunnerCreateArgs,
  buildNetworkKeeperCreateArgs,
  assertWorkerContainerInspection,
  buildDockerIsolationPlan,
  buildWorkerCreateArgs,
  isImmutableDockerImage,
  isolationNames,
  isolationToken,
  NETWORK_KEEPER_SCRIPT,
  WORKER_PATHS,
  type DockerContainerInspection,
} from "./docker-isolation.js";
import type { JobSpec } from "./types.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition } from "../../coding/services/catalog.js";

const image = `registry.example/wardby-worker@sha256:${"a".repeat(64)}`;
const runHash = createHash("sha256").update("run-sensitive-name").digest("hex");
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-sensitive-name",
  image,
  inputArtifact: "/host/secret/input.json",
  timeoutSec: 900,
  limits: { cpus: 1.5, memoryMb: 1024, pids: 64, diskMb: 512 },
  labels: { untrusted: "do-not-expand" },
};

function validWorkerInspection(): DockerContainerInspection {
  const names = isolationNames(spec.runId);
  return {
    Config: {
      User: "10001:10001",
      Image: image,
      Env: ["WARDBY_PROXY_URL=http://wardby-proxy:8787", "WARDBY_RUN_CAPABILITY=test-capability"],
      Labels: {
        "io.wardby.managed": "true",
        "io.wardby.component": "coding-worker",
        "io.wardby.run-sha256": runHash,
      },
    },
    HostConfig: {
      Binds: null,
      CapAdd: null,
      CapDrop: ["ALL"],
      CgroupnsMode: "private",
      CpuPeriod: 100_000,
      CpuQuota: 150_000,
      Devices: [],
      DeviceRequests: null,
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      GroupAdd: null,
      Init: true,
      IpcMode: "none",
      LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      MemorySwappiness: 0,
      NetworkMode: names.network,
      NanoCpus: 1_500_000_000,
      PidsLimit: 64,
      PidMode: "",
      PortBindings: {},
      Privileged: false,
      PublishAllPorts: false,
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
      ShmSize: 16 * 1024 * 1024,
      Tmpfs: { "/tmp": "rw,noexec", "/home/wardby": "rw,noexec" },
      Mounts: [
        {
          Type: "volume",
          Source: names.storageVolume,
          Target: WORKER_PATHS.workspace,
          VolumeOptions: { NoCopy: true, Subpath: "workspace" },
        },
        {
          Type: "volume",
          Source: names.storageVolume,
          Target: WORKER_PATHS.input,
          ReadOnly: true,
          VolumeOptions: { NoCopy: true, Subpath: "input" },
        },
        {
          Type: "volume",
          Source: names.storageVolume,
          Target: WORKER_PATHS.output,
          VolumeOptions: { NoCopy: true, Subpath: "output" },
        },
      ],
    },
    Mounts: [
      { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.workspace, RW: true },
      { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.input, RW: false },
      { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.output, RW: true },
    ],
    NetworkSettings: { Networks: { [names.network]: {} }, Ports: {} },
  };
}

describe("Docker isolation policy", () => {
  it("builds opaque names and fixed arguments without expanding untrusted values", () => {
    const plan = buildDockerIsolationPlan(spec, "trusted-proxy");
    const args = JSON.stringify(plan);
    expect(plan.names).toEqual(isolationNames(spec.runId));
    expect(plan.deadlineMs).toBe(900_000);
    expect(args).not.toContain(spec.runId);
    expect(args).not.toContain(spec.inputArtifact);
    expect(args).not.toContain("do-not-expand");
    expect(plan.workerCreateArgs).toContain("WARDBY_RUN_CAPABILITY");
    expect(args).not.toContain("rrp_");
  });

  it("requires immutable images and bounded resources", () => {
    expect(() => buildWorkerCreateArgs({ ...spec, image: "wardby-worker:latest" })).toThrow(
      "docker_isolation_unsupported",
    );
    expect(() => buildWorkerCreateArgs({ ...spec, limits: { ...spec.limits, pids: 0 } })).toThrow(
      "docker_isolation_unsupported",
    );
  });

  it("uses only the three fixed worker mounts and does not expose Git metadata", () => {
    const args = buildWorkerCreateArgs(spec);
    const mounts = args.filter((value) => value.startsWith("type=volume"));
    expect(mounts).toHaveLength(3);
    expect(mounts).toEqual([
      expect.stringContaining(`dst=${WORKER_PATHS.workspace},volume-subpath=workspace`),
      expect.stringContaining(`dst=${WORKER_PATHS.input},volume-subpath=input`),
      expect.stringContaining(`dst=${WORKER_PATHS.output},volume-subpath=output`),
    ]);
    expect(mounts[0]).not.toContain("readonly");
    expect(mounts[1]).toContain("readonly");
    expect(mounts[2]).not.toContain("readonly");
    expect(args.join(" ")).not.toContain(`dst=${WORKER_PATHS.git}`);
    expect(args).not.toContain("--volume");
  });

  it("gives Claude's agent only input, output, and a socket while the tool runner gets only workspace and socket", () => {
    const claude = {
      ...spec,
      provider: "claude-code" as const,
      toolImage: `registry.example/wardby-tools@sha256:${"b".repeat(64)}`,
    };
    const agent = buildClaudeAgentCreateArgs(claude);
    const tools = buildClaudeToolRunnerCreateArgs(claude);
    const agentMounts = agent.filter((value) => value.startsWith("type=volume"));
    const toolMounts = tools.filter((value) => value.startsWith("type=volume"));
    expect(agentMounts).toEqual([
      expect.stringContaining(`dst=${WORKER_PATHS.input},volume-subpath=input`),
      expect.stringContaining(`dst=${WORKER_PATHS.output},volume-subpath=output`),
      expect.stringContaining(`dst=${WORKER_PATHS.tool},volume-subpath=tool`),
    ]);
    expect(toolMounts).toEqual([
      expect.stringContaining(`dst=${WORKER_PATHS.workspace},volume-subpath=workspace`),
      expect.stringContaining(`dst=${WORKER_PATHS.tool},volume-subpath=tool`),
    ]);
    expect(agentMounts.join(" ")).not.toContain(WORKER_PATHS.workspace);
    expect(toolMounts.join(" ")).not.toContain(WORKER_PATHS.input);
    expect(toolMounts.join(" ")).not.toContain(WORKER_PATHS.output);
    expect(agent).toContain("WARDBY_RUN_CAPABILITY");
    expect(tools.join(" ")).not.toContain("WARDBY_RUN_CAPABILITY");
    expect(tools).toContain("none");
  });

  it("fails closed when mandatory host features are absent", () => {
    const supported = {
      OSType: "linux",
      CgroupVersion: "2",
      MemoryLimit: true,
      SwapLimit: true,
      CpuCfsQuota: true,
      PidsLimit: true,
      SecurityOptions: ["name=seccomp,profile=builtin"],
      Plugins: { Volume: ["local"], Network: ["bridge"] },
    };
    expect(() => assertDockerHostSupportsIsolation(supported)).not.toThrow();
    for (const change of [
      { OSType: "windows" },
      { CgroupVersion: "1" },
      { PidsLimit: false },
      { SecurityOptions: [] },
    ]) {
      expect(() => assertDockerHostSupportsIsolation({ ...supported, ...change })).toThrow(
        "docker_isolation_unsupported",
      );
    }
  });

  it("attests isolated network settings", () => {
    const network = {
      Name: isolationNames(spec.runId).network,
      Driver: "bridge",
      Internal: true,
      EnableIPv6: false,
      Attachable: false,
      Ingress: false,
      Labels: {
        "io.wardby.managed": "true",
        "io.wardby.component": "coding-worker",
        "io.wardby.run-sha256": runHash,
      },
      Options: {
        "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
        "com.docker.network.bridge.gateway_mode_ipv6": "isolated",
      },
    };
    expect(() => assertIsolationNetworkInspection(network, spec.runId)).not.toThrow();
    expect(() => assertIsolationNetworkInspection({ ...network, Internal: false }, spec.runId)).toThrow(
      "docker_isolation_unsupported",
    );
  });

  it("rejects inspection drift before a worker starts", () => {
    const container = validWorkerInspection();
    expect(() => assertWorkerContainerInspection(container, spec, "test-capability")).not.toThrow();
    expect(() =>
      assertWorkerContainerInspection(
        { ...container, HostConfig: { ...container.HostConfig, Privileged: true } },
        spec,
        "test-capability",
      ),
    ).toThrow("docker_isolation_unsupported");
  });

  it("accepts Docker's cgroup v2 null swappiness report while swap remains disabled", () => {
    const names = isolationNames(spec.runId);
    const claude: JobSpec = {
      ...spec,
      provider: "claude-code",
      toolImage: `registry.example/wardby-tools@sha256:${"b".repeat(64)}`,
    };
    const container: DockerContainerInspection = {
      Config: {
        User: "10001:10001",
        Image: claude.toolImage,
        Env: [],
        Labels: {
          "io.wardby.managed": "true",
          "io.wardby.component": "coding-worker",
          "io.wardby.run-sha256": runHash,
        },
      },
      HostConfig: {
        Binds: null,
        CapAdd: null,
        CapDrop: ["ALL"],
        CgroupnsMode: "private",
        Devices: [],
        DeviceRequests: null,
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        GroupAdd: null,
        Init: true,
        IpcMode: "none",
        LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
        Memory: Math.floor(claude.limits.memoryMb / 3) * 1024 * 1024,
        MemorySwap: Math.floor(claude.limits.memoryMb / 3) * 1024 * 1024,
        MemorySwappiness: null,
        NetworkMode: "none",
        NanoCpus: 250_000_000,
        PidsLimit: 16,
        PidMode: "",
        PortBindings: {},
        Privileged: false,
        PublishAllPorts: false,
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
        ShmSize: 16 * 1024 * 1024,
        Tmpfs: { "/tmp": "rw,noexec", "/home/wardby": "rw,noexec" },
        Mounts: [
          {
            Type: "volume",
            Source: names.storageVolume,
            Target: WORKER_PATHS.workspace,
            VolumeOptions: { NoCopy: true, Subpath: "workspace" },
          },
          {
            Type: "volume",
            Source: names.storageVolume,
            Target: WORKER_PATHS.tool,
            VolumeOptions: { NoCopy: true, Subpath: "tool" },
          },
        ],
      },
      Mounts: [
        { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.workspace, RW: true },
        { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.tool, RW: true },
      ],
      NetworkSettings: { Networks: { none: {} }, Ports: {} },
    };
    expect(() => assertClaudeToolRunnerContainerInspection(container, claude)).not.toThrow();
  });
});

const POSTGRES = resolvedFromDefinition(
  BUILTIN_CODING_SERVICES.find((service) => service.name === "postgres" && service.version === "16")!,
);
const withServices: JobSpec = { ...spec, services: [POSTGRES] };
const KEEPER_ID = "f".repeat(64);
const isolationLabels = {
  "io.wardby.managed": "true",
  "io.wardby.component": "coding-worker",
  "io.wardby.run-sha256": runHash,
};

function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1] ?? ""] : []));
}

function validNetworkKeeperInspection(): DockerContainerInspection {
  const names = isolationNames(spec.runId);
  return {
    Id: KEEPER_ID,
    Config: { User: "10001:10001", Image: image, Labels: isolationLabels },
    HostConfig: {
      NetworkMode: names.network,
      ReadonlyRootfs: true,
      Privileged: false,
      Binds: null,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
      PidsLimit: 32,
      Memory: 64 * 1024 * 1024,
      RestartPolicy: { Name: "no" },
      Dns: [],
      ExtraHosts: null,
      PortBindings: {},
    },
    Mounts: [],
    NetworkSettings: { Networks: { [names.network]: {} } },
  };
}

describe("Docker isolation with services", () => {
  it("names the network keeper with the run's opaque token", () => {
    const token = isolationToken(spec.runId);
    expect(token).toMatch(/^[a-f0-9]{20}$/);
    expect(isolationNames(spec.runId).network).toBe(`wardby-net-${token}`);
    expect(isolationNames(spec.runId).networkKeeperContainer).toBe(`wardby-netns-${token}`);
  });

  it("adds a network keeper and moves the worker into its namespace only for a run with services", () => {
    const plain = buildDockerIsolationPlan(spec, "trusted-proxy");
    expect(plain).not.toHaveProperty("networkKeeperCreateArgs");
    expect(flagValues(plain.workerCreateArgs, "--network")).toEqual([plain.names.network]);

    const plan = buildDockerIsolationPlan(withServices, "trusted-proxy");
    expect(plan.networkKeeperCreateArgs).toEqual(buildNetworkKeeperCreateArgs(withServices));
    expect(flagValues(plan.workerCreateArgs, "--network")).toEqual([`container:${plan.names.networkKeeperContainer}`]);
  });

  it("builds a mount-free, bounded network keeper on the run's internal network", () => {
    const names = isolationNames(spec.runId);
    const args = buildNetworkKeeperCreateArgs(withServices);
    expect(args.slice(0, 4)).toEqual(["container", "create", "--name", names.networkKeeperContainer]);
    expect(flagValues(args, "--network")).toEqual([names.network]);
    expect(flagValues(args, "--user")).toEqual(["10001:10001"]);
    expect(flagValues(args, "--cap-drop")).toEqual(["ALL"]);
    expect(flagValues(args, "--security-opt")).toEqual(["no-new-privileges=true", "seccomp=builtin"]);
    expect(flagValues(args, "--memory")).toEqual(["64m"]);
    expect(flagValues(args, "--pids-limit")).toEqual(["32"]);
    expect(flagValues(args, "--pull")).toEqual(["never"]);
    expect(args).toContain("--read-only");
    for (const forbidden of ["--mount", "--tmpfs", "--env", "--publish", "--dns", "--add-host"]) {
      expect(args).not.toContain(forbidden);
    }
    expect(flagValues(args, "--entrypoint")).toEqual(["node"]);
    expect(args.slice(-3)).toEqual([image, "-e", NETWORK_KEEPER_SCRIPT]);
    expect(() => buildNetworkKeeperCreateArgs(spec)).toThrow("docker_isolation_unsupported");
  });

  it("refuses services on a Claude run and an empty service list", () => {
    const claude: JobSpec = {
      ...withServices,
      provider: "claude-code",
      toolImage: `registry.example/wardby-tools@sha256:${"b".repeat(64)}`,
    };
    expect(() => buildDockerIsolationPlan(claude, "trusted-proxy")).toThrow("docker_isolation_unsupported");
    expect(() => buildDockerIsolationPlan({ ...spec, services: [] }, "trusted-proxy")).toThrow(
      "docker_isolation_unsupported",
    );
  });

  it("attests the network keeper", () => {
    const keeper = validNetworkKeeperInspection();
    expect(() => assertNetworkKeeperContainerInspection(keeper, withServices)).not.toThrow();
    for (const drift of [
      { ...keeper, Mounts: [{ Type: "volume", Name: "x", Destination: "/data", RW: true }] },
      { ...keeper, HostConfig: { ...keeper.HostConfig, NetworkMode: "none" } },
      { ...keeper, HostConfig: { ...keeper.HostConfig, Privileged: true } },
      { ...keeper, NetworkSettings: { Networks: { bridge: {} } } },
    ]) {
      expect(() => assertNetworkKeeperContainerInspection(drift, withServices)).toThrow("docker_isolation_unsupported");
    }
    expect(() => assertNetworkKeeperContainerInspection(keeper, spec)).toThrow("docker_isolation_unsupported");
  });

  it("attests a services worker in the keeper's namespace and nowhere else", () => {
    const names = isolationNames(spec.runId);
    const base = validWorkerInspection();
    const shared: DockerContainerInspection = {
      ...base,
      HostConfig: { ...base.HostConfig, NetworkMode: `container:${KEEPER_ID}` },
      NetworkSettings: { Networks: {}, Ports: {} },
    };
    const byName: DockerContainerInspection = {
      ...shared,
      HostConfig: { ...shared.HostConfig, NetworkMode: `container:${names.networkKeeperContainer}` },
    };
    expect(() => assertWorkerContainerInspection(shared, withServices, "test-capability", KEEPER_ID)).not.toThrow();
    expect(() => assertWorkerContainerInspection(byName, withServices, "test-capability")).not.toThrow();
    expect(() => assertWorkerContainerInspection(shared, withServices, "test-capability", "0".repeat(64))).toThrow(
      "docker_isolation_unsupported",
    );
    expect(() => assertWorkerContainerInspection(base, withServices, "test-capability", KEEPER_ID)).toThrow(
      "docker_isolation_unsupported",
    );
    expect(() => assertWorkerContainerInspection(shared, spec, "test-capability", KEEPER_ID)).toThrow(
      "docker_isolation_unsupported",
    );
    expect(() =>
      assertWorkerContainerInspection(
        { ...shared, NetworkSettings: { Networks: { [names.network]: {} }, Ports: {} } },
        withServices,
        "test-capability",
        KEEPER_ID,
      ),
    ).toThrow("docker_isolation_unsupported");
  });
});

describe("Docker isolation parity for runs without services", () => {
  const claude: JobSpec = {
    ...spec,
    provider: "claude-code",
    toolImage: `registry.example/wardby-tools@sha256:${"b".repeat(64)}`,
  };

  // Recorded before services existed on Docker. Never update this snapshot:
  // a run without services must issue exactly these arguments.
  it.each([
    ["codex", spec],
    ["claude-code", claude],
  ])("keeps every %s argument list unchanged", (_label, job) => {
    const { names: _names, ...plan } = buildDockerIsolationPlan(job, "trusted-proxy");
    expect(plan).toMatchSnapshot();
  });
});

describe("isImmutableDockerImage", () => {
  const digest = `@sha256:${"c".repeat(64)}`;

  it.each([
    `sha256:${"c".repeat(64)}`,
    `wardby-worker${digest}`,
    `registry.example/wardby-worker${digest}`,
    `localhost:5001/wardby-coding-worker${digest}`,
    `registry.example.com:443/a/b${digest}`,
  ])("accepts digest-pinned reference %s", (reference) => {
    expect(isImmutableDockerImage(reference)).toBe(true);
  });

  it.each([
    ["a tag before the digest", `wardby-worker:dev${digest}`],
    ["a tag with a numeric value and no path", `wardby-worker:5001${digest}`],
    ["a tag after a registry port", `localhost:5001/wardby-coding-worker:dev${digest}`],
    ["a port on a later path component", `registry.example/team:5001/worker${digest}`],
    ["a port-only first component", `:5001/wardby-worker${digest}`],
    ["an empty port", `localhost:/wardby-worker${digest}`],
    ["a six-digit port", `localhost:500100/wardby-worker${digest}`],
    ["an empty path component", `localhost:5001//wardby-worker${digest}`],
    ["a trailing slash", `localhost:5001/wardby-worker/${digest}`],
    ["a tag without a digest", "localhost:5001/wardby-worker:latest"],
    ["a short digest", `localhost:5001/wardby-worker@sha256:${"c".repeat(63)}`],
  ])("rejects %s", (_label, reference) => {
    expect(isImmutableDockerImage(reference)).toBe(false);
  });
});
