/**
 * Attestation against the EKS mutation set (provisional until PR 3's capture). Same shape as
 * kubernetes-autopilot-attestation.test.ts: the submitted pod comes from the live builder, the
 * fixture supplies only what the platform changes.
 */
import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { KUBERNETES_ISOLATION_ERROR, assertRunPodMatches, buildRunPod } from "./kubernetes-isolation.js";
import { applyMutations, loadDryRunFixture } from "./kubernetes-dry-run-fixture.js";
import type { JobSpec } from "./types.js";

const IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/wardby/coding-worker@sha256:${"a".repeat(64)}`;
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-eks-1",
  provider: "codex",
  image: IMAGE,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};
const options = {
  namespace: "wardby-coding",
  proxyIp: "10.96.0.50",
  runtimeClassName: "gvisor",
  platform: "eks" as const,
};
const fixture = loadDryRunFixture("eks");
const submitted = () => buildRunPod(spec, options);
const returned = () => applyMutations(submitted(), fixture.mutations);

describe("EKS attestation", () => {
  it.skipIf(fixture.provisional)(
    fixture.provisional
      ? "PENDING: the committed EKS fixture is PROVISIONAL, not a server-side dry-run capture"
      : "the committed EKS fixture is a real server-side dry-run capture",
    () => {
      expect(fixture.provisional).toBe(false);
      expect(fixture.source).not.toContain("PROVISIONAL");
    },
  );

  it("accepts the recorded mutation set under eks", () => {
    expect(() => assertRunPodMatches(returned(), submitted(), "eks")).not.toThrow();
  });

  it("rejects it under generic and gke-autopilot", () => {
    expect(() => assertRunPodMatches(returned(), submitted(), "generic")).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => assertRunPodMatches(returned(), submitted(), "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("rejects one more mutation the profile does not name", () => {
    for (const tamper of [
      (p: V1Pod) => void (p.spec!.nodeSelector!["wardby.dev/sandbox"] = "none"),
      (p: V1Pod) => void p.spec!.tolerations!.push({ key: "anything", operator: "Exists" }),
      (p: V1Pod) => void ((p.metadata!.annotations ??= {})["dev.gvisor.internal.seccomp.worker"] = "x"),
      (p: V1Pod) => void (p.spec!.hostPID = true),
      (p: V1Pod) => void delete p.spec!.runtimeClassName,
    ]) {
      const tampered = returned();
      tamper(tampered);
      expect(() => assertRunPodMatches(tampered, submitted(), "eks")).toThrow(KUBERNETES_ISOLATION_ERROR);
    }
  });
});
