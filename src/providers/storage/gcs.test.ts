import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runBlobStoreContract } from "./blob-store-contract.js";
import { GcsBlobStore, type GcsBucketLike, type GcsFileLike } from "./gcs.js";

interface StoredObject {
  data: Buffer;
  updated: Date;
  contentType?: string;
  metadata: Record<string, string>;
}

class NotFound extends Error {
  readonly code = 404;
}

/** In-memory stand-in for the slice of the GCS client the adapter uses. An object only exists once its write stream finishes. */
export class FakeGcsBucket implements GcsBucketLike {
  readonly objects = new Map<string, StoredObject>();
  readonly destroyedWrites: string[] = [];
  readonly writeOptions: unknown[] = [];

  file(name: string): GcsFileLike {
    const { objects, writeOptions, destroyedWrites } = this;
    const need = (): StoredObject => {
      const found = objects.get(name);
      if (!found) throw new NotFound("No such object");
      return found;
    };
    return {
      createWriteStream(options) {
        writeOptions.push(options);
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
          final(callback) {
            objects.set(name, {
              data: Buffer.concat(chunks),
              updated: new Date(),
              contentType: options?.contentType,
              metadata: { ...options?.metadata?.metadata },
            });
            callback();
          },
          destroy(error, callback) {
            if (!this.writableFinished) destroyedWrites.push(name);
            callback(error);
          },
        });
      },
      createReadStream() {
        return Readable.from([need().data], { objectMode: false });
      },
      async getMetadata() {
        const found = need();
        return [{ size: String(found.data.length), updated: found.updated.toISOString(), metadata: found.metadata }];
      },
      async setMetadata(update) {
        const found = need();
        found.metadata = { ...found.metadata, ...update.metadata };
        return [{}];
      },
      async save(data, options) {
        objects.set(name, {
          data: Buffer.from(data),
          updated: new Date(),
          contentType: options?.contentType,
          metadata: { ...options?.metadata?.metadata },
        });
      },
      async delete() {
        objects.delete(name);
        return [{}];
      },
      async getSignedUrl(config) {
        return [`https://storage.example/${name}?method=${config.action}&expires=${config.expires}`];
      },
    };
  }
}

runBlobStoreContract("gcs", async () => ({ store: new GcsBlobStore(new FakeGcsBucket()) }));

describe("GcsBlobStore specifics", () => {
  it("writes non-resumable uploads and records the sha256 as object metadata", async () => {
    const bucket = new FakeGcsBucket();
    const store = new GcsBlobStore(bucket);
    const { sha256 } = await store.putStream("snap/a.tar", Readable.from([Buffer.from("abc")]), {
      contentType: "application/x-tar",
    });
    expect(bucket.writeOptions[0]).toMatchObject({ resumable: false, contentType: "application/x-tar" });
    expect(bucket.objects.get("snap/a.tar")?.metadata["x-wardby-sha256"]).toBe(sha256);
    expect((await store.head("snap/a.tar"))?.sha256).toBe(sha256);
  });

  it("put records the sha256 too", async () => {
    const bucket = new FakeGcsBucket();
    const store = new GcsBlobStore(bucket);
    await store.put("snap/b.bin", Buffer.from("abc"));
    expect((await store.head("snap/b.bin"))?.sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("destroys the write stream so an over-limit upload is never finalized", async () => {
    const bucket = new FakeGcsBucket();
    const store = new GcsBlobStore(bucket);
    await expect(
      store.putStream("snap/x.tar", Readable.from([Buffer.alloc(50)]), { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "blob_too_large" });
    expect(bucket.destroyedWrites).toEqual(["snap/x.tar"]);
    expect(bucket.objects.size).toBe(0);
  });

  it("signedUrl asks for a v4 URL with the right action and expiry", async () => {
    const store = new GcsBlobStore(new FakeGcsBucket());
    const url = await store.signedUrl("snap/a.tar", { expiresSec: 60, method: "PUT" });
    expect(url).toContain("method=write");
    const get = await store.signedUrl("snap/a.tar", { expiresSec: 60, method: "GET" });
    expect(get).toContain("method=read");
  });

  it("surfaces non-404 errors unchanged", async () => {
    const bucket = new FakeGcsBucket();
    const store = new GcsBlobStore({
      file: () => ({
        ...bucket.file("x"),
        getMetadata: async () => {
          throw Object.assign(new Error("boom"), { code: 503 });
        },
      }),
    });
    await expect(store.head("snap/a.tar")).rejects.toThrow("boom");
  });
});
