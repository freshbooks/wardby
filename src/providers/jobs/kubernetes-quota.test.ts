import type { V1Pod, V1ResourceQuota } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { cpuMillicores, memoryBytes, podQuotaUsage, quotaShortfall } from "./kubernetes-quota.js";

const resources = (cpu: string, memory: string) => ({ requests: { cpu, memory }, limits: { cpu, memory } });

/** A worker plus a native Postgres sidecar plus a small ordinary init container. */
const pod: V1Pod = {
  spec: {
    containers: [{ name: "worker", resources: resources("1000m", "2Gi") }],
    initContainers: [
      { name: "storage-init", resources: resources("100m", "64Mi") },
      { name: "postgres", restartPolicy: "Always", resources: resources("500m", "512Mi") },
    ],
  },
};

const quota = (hard: Record<string, string>, used: Record<string, string>): V1ResourceQuota => ({
  status: { hard, used },
});

describe("quantities", () => {
  it("reads CPU in millicores and memory in bytes", () => {
    expect([cpuMillicores("250m"), cpuMillicores("1.5"), cpuMillicores("8"), cpuMillicores(undefined)]).toEqual([
      250, 1500, 8000, 0,
    ]);
    expect([memoryBytes("512Mi"), memoryBytes("16Gi"), memoryBytes("1G"), memoryBytes("1024")]).toEqual([
      512 * 2 ** 20,
      16 * 2 ** 30,
      1e9,
      1024,
    ]);
    expect(cpuMillicores("a lot")).toBeNull();
    expect(memoryBytes("12Xi")).toBeNull();
  });
});

describe("podQuotaUsage", () => {
  it("counts containers and native sidecars, and one pod", () => {
    expect(podQuotaUsage(pod)).toEqual({
      "requests.cpu": 1500,
      "limits.cpu": 1500,
      "requests.memory": 2 * 2 ** 30 + 512 * 2 ** 20,
      "limits.memory": 2 * 2 ** 30 + 512 * 2 ** 20,
      pods: 1,
    });
  });

  it("uses a larger ordinary init container instead, when there is one", () => {
    const big: V1Pod = {
      spec: {
        containers: [{ name: "w", resources: resources("100m", "64Mi") }],
        initContainers: [{ name: "i", resources: resources("2", "4Gi") }],
      },
    };
    expect(podQuotaUsage(big)["requests.cpu"]).toBe(2000);
  });
});

describe("quotaShortfall", () => {
  const hard = {
    "requests.cpu": "8",
    "limits.cpu": "8",
    "requests.memory": "16Gi",
    "limits.memory": "16Gi",
    pods: "20",
  };

  it("is null while the pod fits", () => {
    expect(
      quotaShortfall(
        quota(hard, {
          "requests.cpu": "6",
          "limits.cpu": "6",
          "requests.memory": "8Gi",
          "limits.memory": "8Gi",
          pods: "5",
        }),
        podQuotaUsage(pod),
      ),
    ).toBeNull();
  });

  it("names the first resource the pod would exceed", () => {
    // The live refusal: 6.7 of 8 CPU used, a 1.75 CPU pod asked for.
    expect(
      quotaShortfall(quota(hard, { "requests.cpu": "6700m", "limits.cpu": "6700m", pods: "6" }), {
        ...podQuotaUsage(pod),
        "requests.cpu": 1750,
        "limits.cpu": 1750,
      }),
    ).toBe("requests.cpu");
    expect(quotaShortfall(quota({ pods: "6" }, { pods: "6" }), podQuotaUsage(pod))).toBe("pods");
    expect(quotaShortfall(quota({ memory: "3Gi" }, { memory: "1Gi" }), podQuotaUsage(pod))).toBe("memory");
  });

  it("never blocks on a quota without status or with values it can't read", () => {
    expect(quotaShortfall({ spec: { hard } }, podQuotaUsage(pod))).toBeNull();
    expect(quotaShortfall(quota({ "requests.cpu": "lots" }, {}), podQuotaUsage(pod))).toBeNull();
  });
});
