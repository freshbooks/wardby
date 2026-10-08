import { describe, expect, it } from "vitest";
import {
  buildGatewayConnectArgs,
  buildNativeNetworkCreateArgs,
  buildNativeWorkerRunArgs,
  DEFAULT_NATIVE_WORKER_LIMITS,
  nativeGatewayUrl,
  nativeIsolationNames,
} from "./docker-isolation.js";

const runId = "cmrun_native_1";
const image = `ghcr.io/wardby/wardby/wardby-native-worker@sha256:${"a".repeat(64)}`;

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("native worker Docker isolation", () => {
  it("names every object by an opaque run hash, never the run id", () => {
    const names = nativeIsolationNames(runId);
    expect(names.network).toMatch(/^wardby-nnet-[0-9a-f]{20}$/);
    expect(names.worker).toMatch(/^wardby-native-[0-9a-f]{20}$/);
    expect(
      JSON.stringify(buildNativeWorkerRunArgs({ runId, image, limits: DEFAULT_NATIVE_WORKER_LIMITS })),
    ).not.toContain(runId);
  });

  it("creates an internal network with no route out", () => {
    const args = buildNativeNetworkCreateArgs(runId);
    expect(args).toContain("--internal");
    expect(args).toContain("com.docker.network.bridge.gateway_mode_ipv4=isolated");
    expect(args).toContain("--ipv6=false");
    expect(args.at(-1)).toBe(nativeIsolationNames(runId).network);
  });

  it("joins the gateway container under the alias workers dial", () => {
    expect(buildGatewayConnectArgs(runId, "wardby-gateway")).toEqual([
      "network",
      "connect",
      "--alias",
      "wardby-native-gateway",
      nativeIsolationNames(runId).network,
      "wardby-gateway",
    ]);
    expect(nativeGatewayUrl()).toBe("http://wardby-native-gateway:8790/native-gateway/v1/call");
  });

  it("runs the worker locked down: input on stdin, run network only, read-only, no capabilities, limited", () => {
    const args = buildNativeWorkerRunArgs({ runId, image, limits: { cpus: 1, memoryMb: 512, pids: 128 } });
    expect(args.slice(0, 2)).toEqual(["run", "-i"]);
    expect(args).not.toContain("--rm");
    expect(flagValue(args, "--network")).toBe(nativeIsolationNames(runId).network);
    expect(flagValue(args, "--user")).toBe("10001:10001");
    expect(args).toContain("--read-only");
    expect(flagValue(args, "--cap-drop")).toBe("ALL");
    expect(args).toContain("no-new-privileges=true");
    expect(flagValue(args, "--ipc")).toBe("none");
    expect(flagValue(args, "--cpus")).toBe("1");
    expect(flagValue(args, "--memory")).toBe("512m");
    expect(flagValue(args, "--memory-swap")).toBe("512m");
    expect(flagValue(args, "--pids-limit")).toBe("128");
    expect(flagValue(args, "--tmpfs")).toBe("/tmp:rw,noexec,nosuid,nodev,size=64m");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--mount");
    expect(args.at(-1)).toBe(image);
  });

  it("refuses an image that is not pinned", () => {
    expect(() =>
      buildNativeWorkerRunArgs({
        runId,
        image: "ghcr.io/wardby/wardby/wardby-native-worker:latest",
        limits: DEFAULT_NATIVE_WORKER_LIMITS,
      }),
    ).toThrow(/native_sandbox_image_not_pinned/);
    expect(() =>
      buildNativeWorkerRunArgs({ runId, image: `sha256:${"b".repeat(64)}`, limits: DEFAULT_NATIVE_WORKER_LIMITS }),
    ).not.toThrow();
  });
});
