import { describe, expect, it } from "vitest";
import type { PodView } from "./adapter";
import { containerDot, podReadiness } from "./format";

const c = (name: string, role: string, ready: boolean, state = "running", reason: string | null = null) => ({
  name,
  role,
  ready,
  state,
  reason,
});

describe("podReadiness", () => {
  it("counts like kubectl READY: a finished init step is left out", () => {
    const pod = {
      terminating: false,
      phase: "Pending",
      containers: [
        c("storage-init", "init", true, "terminated", "Completed"),
        c("tool-runner", "sidecar", true),
        c("keeper", "sidecar", false, "waiting"),
        c("worker", "main", false, "waiting"),
      ],
    } as unknown as PodView;
    expect(podReadiness(pod).text).toBe("1/3");
  });
});

describe("containerDot", () => {
  it("shows a finished init step as done, not ready", () => {
    expect(containerDot(c("storage-init", "init", true, "terminated", "Completed"))).toBe("idle");
    expect(containerDot(c("tool-runner", "sidecar", true))).toBe("ok");
  });
});
