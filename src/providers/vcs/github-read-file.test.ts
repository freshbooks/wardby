import { describe, expect, it } from "vitest";
import { REPO, fakeGitHub, json } from "../review-host/github.test-support.js";

const FILE = `/repos/${REPO}/contents/.wardby/services.yaml?ref=main`;
const read = (client: ReturnType<typeof fakeGitHub>["client"], path = ".wardby/services.yaml", maxBytes = 8192) =>
  client.readFileAtRef({ repository: REPO, ref: "main", path, maxBytes });

describe("GitHubAppClient.readFileAtRef", () => {
  it("reads a file's raw text at a ref with a Contents: read token", async () => {
    const { client, calls, grants } = fakeGitHub(({ path }) =>
      path === FILE
        ? new Response('services:\n  postgres: "16"\n', {
            headers: { "content-type": "application/vnd.github.raw+json" },
          })
        : undefined,
    );
    await expect(read(client)).resolves.toBe('services:\n  postgres: "16"\n');
    expect(grants).toEqual([{ contents: "read" }]);
    expect(calls[0]).toMatchObject({ method: "GET", accept: "application/vnd.github.raw+json" });
  });

  it("returns null when the file does not exist", async () => {
    const { client } = fakeGitHub(({ path }) => (path === FILE ? json({ message: "Not Found" }, 404) : undefined));
    await expect(read(client)).resolves.toBeNull();
  });

  it("refuses a file over the byte cap", async () => {
    const { client } = fakeGitHub(({ path }) =>
      path === FILE
        ? new Response("x".repeat(9000), { headers: { "content-type": "application/vnd.github.raw+json" } })
        : undefined,
    );
    await expect(read(client)).rejects.toThrow("github_file_too_large");
  });

  it("refuses a directory", async () => {
    const { client } = fakeGitHub(({ path }) => (path === FILE ? json([{ type: "file", path: "x" }]) : undefined));
    await expect(read(client)).rejects.toThrow("github_file_not_a_file");
  });

  // The array case above is a directory listing; this covers the other
  // "metadata instead of raw content" shape GitHub returns for an entry the
  // raw media type doesn't apply to (a symlink or submodule): a single JSON
  // object whose `type` isn't "file".
  it("refuses a symlink returned as metadata instead of raw content", async () => {
    const { client } = fakeGitHub(({ path }) =>
      path === FILE
        ? json({ type: "symlink", path: ".wardby/services.yaml", target: "../shared/services.yaml" })
        : undefined,
    );
    await expect(read(client)).rejects.toThrow("github_file_not_a_file");
  });

  it("refuses bytes that are not UTF-8", async () => {
    const { client } = fakeGitHub(({ path }) =>
      path === FILE
        ? new Response(new Uint8Array([0xff, 0xfe, 0x00]), {
            headers: { "content-type": "application/vnd.github.raw+json" },
          })
        : undefined,
    );
    await expect(read(client)).rejects.toThrow("github_file_not_utf8");
  });

  it.each(["../etc/passwd", "/abs", "a//b", ".wardby/./x", ""])(
    "refuses the path %j before calling GitHub",
    async (path) => {
      const { client, calls } = fakeGitHub(() => undefined);
      await expect(read(client, path)).rejects.toThrow("github_file_path_invalid");
      expect(calls).toEqual([]);
    },
  );
});
