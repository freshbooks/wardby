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
});
