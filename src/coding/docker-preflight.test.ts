import { describe, expect, it } from "vitest";

import { dockerCodingPreflight } from "./docker-preflight.js";

const ID = `sha256:${"a".repeat(64)}`;

describe("dockerCodingPreflight", () => {
  it("passes for an immutable image Docker can inspect", async () => {
    expect(await dockerCodingPreflight({ workerImage: ID, proxyContainer: "p" }, async () => true)).toBeNull();
  });

  it("needs both the worker image and the proxy container", async () => {
    expect(await dockerCodingPreflight({ workerImage: ID }, async () => true)).toMatch(/CODING_PROXY_CONTAINER/);
  });

  it("refuses a mutable tag without inspecting it", async () => {
    let inspected = false;
    const result = await dockerCodingPreflight({ workerImage: "worker:latest", proxyContainer: "p" }, async () => {
      inspected = true;
      return true;
    });
    expect(result).toMatch(/immutable/);
    expect(inspected).toBe(false);
  });

  it("reports an image Docker cannot inspect", async () => {
    expect(await dockerCodingPreflight({ workerImage: ID, proxyContainer: "p" }, async () => false)).toMatch(
      /cannot inspect/,
    );
  });

  it("passes with only the Claude Code images", async () => {
    const inspected: string[] = [];
    const tool = `sha256:${"c".repeat(64)}`;
    const result = await dockerCodingPreflight(
      { claudeWorkerImage: ID, claudeToolRunnerImage: tool, proxyContainer: "p" },
      async (image) => {
        inspected.push(image);
        return true;
      },
    );
    expect(result).toBeNull();
    expect(inspected).toEqual([ID, tool]);
  });

  it("checks every configured image", async () => {
    const tool = `sha256:${"c".repeat(64)}`;
    const result = await dockerCodingPreflight(
      { workerImage: ID, claudeWorkerImage: ID, claudeToolRunnerImage: tool, proxyContainer: "p" },
      async (image) => image !== tool,
    );
    expect(result).toBe(`Docker cannot inspect coding worker image "${tool}".`);
  });

  it("refuses a mutable Claude Code image", async () => {
    const result = await dockerCodingPreflight(
      { claudeWorkerImage: "claude:latest", claudeToolRunnerImage: ID, proxyContainer: "p" },
      async () => true,
    );
    expect(result).toMatch(/CODING_CLAUDE_WORKER_IMAGE must use an immutable/);
  });

  it("names both options when neither provider's images are set", async () => {
    const result = await dockerCodingPreflight({ claudeWorkerImage: ID, proxyContainer: "p" }, async () => true);
    expect(result).toBe(
      "CODING_WORKER_IMAGE (Codex) or both CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE (Claude Code) are required when JOB_LAUNCHER=docker.",
    );
  });
});
