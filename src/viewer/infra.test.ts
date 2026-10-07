import { describe, expect, it } from "vitest";
import { InfraInfoSchema } from "./api-schema.js";
import { buildInfraInfo } from "./infra.js";

describe("buildInfraInfo", () => {
  it("describes a kubernetes launcher from its config", () => {
    const info = buildInfraInfo({
      JOB_LAUNCHER: "kubernetes",
      KUBERNETES_NAMESPACE: "wardby-coding",
      KUBERNETES_PLATFORM: "gke-autopilot",
      KUBERNETES_RUNTIME_CLASS: "gvisor",
      KUBERNETES_CONTEXT: "gke_secret-project_us-central1_cluster",
    });
    expect(InfraInfoSchema.parse(info)).toEqual(info);
    expect(info).toEqual({
      launcher: "kubernetes",
      kubernetes: {
        namespace: "wardby-coding",
        platform: "gke-autopilot",
        runtimeClass: "gvisor",
        proxyService: "wardby-coding-proxy",
        runLabel: "wardby.io/run-sha256",
        runLabelHashChars: 40,
        componentLabel: { "wardby.io/component": "coding-run" },
        managedByLabel: { "app.kubernetes.io/managed-by": "wardby" },
      },
    });
    // The server's kube context is meaningless to the client and names the project.
    expect(JSON.stringify(info)).not.toContain("secret-project");
  });

  it("defaults namespace, platform and runtime class", () => {
    const info = buildInfraInfo({ JOB_LAUNCHER: "kubernetes" });
    expect(info.kubernetes).toMatchObject({ namespace: "wardby-coding", platform: "generic", runtimeClass: null });
  });

  it("has no kubernetes block for docker or local launchers", () => {
    expect(buildInfraInfo({ JOB_LAUNCHER: "docker" })).toEqual({ launcher: "docker", kubernetes: null });
    expect(buildInfraInfo({})).toEqual({ launcher: "local", kubernetes: null });
  });
});
