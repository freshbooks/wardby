import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBlobStore } from "./index.js";
import { GcsBlobStore } from "./gcs.js";
import { LocalBlobStore } from "./local.js";
import { S3BlobStore } from "./s3.js";
import { runBlobStoreContract } from "./blob-store-contract.js";

async function makeLocal() {
  const dir = await mkdtemp(join(tmpdir(), "blob-local-"));
  return { store: new LocalBlobStore(dir), dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

runBlobStoreContract("local", makeLocal);

describe("LocalBlobStore specifics", () => {
  it("signedUrl is not_supported", async () => {
    const { store, cleanup } = await makeLocal();
    await expect(store.signedUrl("snap/a", { expiresSec: 60, method: "GET" })).rejects.toMatchObject({
      code: "not_supported",
    });
    await cleanup();
  });

  it("leaves no temp files after an aborted or failed write", async () => {
    const { store, dir, cleanup } = await makeLocal();
    await expect(
      store.putStream("snap/x.tar", Readable.from([Buffer.alloc(50)]), { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "blob_too_large" });
    expect(await readdir(join(dir, "snap"))).toEqual([]);
    await cleanup();
  });
});

describe("createBlobStore", () => {
  it("builds a local store", () => {
    expect(createBlobStore({ kind: "local", localDir: "/tmp/x" })).toBeInstanceOf(LocalBlobStore);
  });
  it("builds gcs and s3 stores from config", () => {
    expect(createBlobStore({ kind: "gcs", bucket: "snapshots" })).toBeInstanceOf(GcsBlobStore);
    expect(createBlobStore({ kind: "s3", bucket: "snapshots", region: "us-east-1" })).toBeInstanceOf(S3BlobStore);
    expect(
      createBlobStore({ kind: "s3", bucket: "snapshots", region: "us-east-1", endpoint: "http://minio:9000" }),
    ).toBeInstanceOf(S3BlobStore);
  });
});
