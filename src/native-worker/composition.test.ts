import { describe, expect, it } from "vitest";
import { loadNativeSandboxConfig } from "../config/providers.js";
import type { NativeRunProviders } from "../core/runner.js";
import { buildNativeSandboxExecutor } from "./composition.js";
import { NativeSandboxExecutor } from "./sandbox-executor.js";

const image = `ghcr.io/wardby/wardby/wardby-native-worker@sha256:${"a".repeat(64)}`;
const base = { NATIVE_SANDBOX_LAUNCHER: "docker", NATIVE_SANDBOX_WORKER_IMAGE: image, NATIVE_GATEWAY_CONTAINER: "gw" };

describe("native sandbox configuration", () => {
  it("is off when NATIVE_SANDBOX_LAUNCHER is unset", () => {
    expect(loadNativeSandboxConfig({})).toBeUndefined();
    expect(
      buildNativeSandboxExecutor({ db: {} as never, providers: {} as NativeRunProviders, env: {} }),
    ).toBeUndefined();
  });

  it("reads the Docker launcher with defaults: 1 CPU, 512 MiB, 128 PIDs", () => {
    expect(loadNativeSandboxConfig(base)).toEqual({
      launcher: "docker",
      workerImage: image,
      gatewayContainer: "gw",
      cpus: 1,
      memoryMb: 512,
      pids: 128,
    });
    expect(
      loadNativeSandboxConfig({
        ...base,
        NATIVE_SANDBOX_CPUS: "0.5",
        NATIVE_SANDBOX_MEMORY_MB: "256",
        NATIVE_SANDBOX_PIDS: "64",
      }),
    ).toMatchObject({ cpus: 0.5, memoryMb: 256, pids: 64 });
  });

  it("fails fast on a configuration that cannot work", () => {
    expect(() => loadNativeSandboxConfig({ NATIVE_SANDBOX_LAUNCHER: "kubernetes" })).toThrow(/must be "docker"/);
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_WORKER_IMAGE: "" })).toThrow(
      /NATIVE_SANDBOX_WORKER_IMAGE is required/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_GATEWAY_CONTAINER: "" })).toThrow(
      /NATIVE_GATEWAY_CONTAINER is required/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_GATEWAY_URL: "not a url" })).toThrow(/NATIVE_GATEWAY_URL/);
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_MEMORY_MB: "-1" })).toThrow(
      /NATIVE_SANDBOX_MEMORY_MB/,
    );
  });

  it("builds the executor when configured", () => {
    expect(
      buildNativeSandboxExecutor({ db: {} as never, providers: {} as NativeRunProviders, env: base }),
    ).toBeInstanceOf(NativeSandboxExecutor);
  });
});
