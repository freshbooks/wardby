import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BlobStoreError, type BlobStore } from "./types.js";

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function chunked(parts: Buffer[]): Readable {
  return Readable.from(parts, { objectMode: false });
}

/**
 * Behaviour every BlobStore adapter must have. Call from an adapter's test file;
 * `makeStore` runs once per test and may return a cleanup.
 */
export function runBlobStoreContract(
  name: string,
  makeStore: () => Promise<{ store: BlobStore; cleanup?: () => Promise<void> }>,
): void {
  describe(`${name} BlobStore contract`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    });
    async function fresh(): Promise<BlobStore> {
      const made = await makeStore();
      if (made.cleanup) cleanups.push(made.cleanup);
      return made.store;
    }

    it("round-trips a stream and reports size and sha256", async () => {
      const store = await fresh();
      const data = Buffer.from("hello dependency cache ".repeat(1000));
      const result = await store.putStream("snap/a.tar", chunked([data.subarray(0, 5000), data.subarray(5000)]));
      expect(result).toEqual({ sizeBytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
      expect(await collect(await store.getStream("snap/a.tar"))).toEqual(data);
      expect(await store.get("snap/a.tar")).toEqual(data);
      const info = await store.head("snap/a.tar");
      expect(info?.sizeBytes).toBe(data.length);
      expect(info?.updatedAt).toBeInstanceOf(Date);
    });

    it("aborts past maxBytes with blob_too_large and leaves no object", async () => {
      const store = await fresh();
      const body = chunked([Buffer.alloc(600), Buffer.alloc(600)]);
      await expect(store.putStream("snap/big.tar", body, { maxBytes: 1000 })).rejects.toMatchObject({
        code: "blob_too_large",
      });
      expect(await store.head("snap/big.tar")).toBeNull();
    });

    it("accepts a body of exactly maxBytes", async () => {
      const store = await fresh();
      const result = await store.putStream("snap/exact.tar", chunked([Buffer.alloc(1000)]), { maxBytes: 1000 });
      expect(result.sizeBytes).toBe(1000);
    });

    it("rejects invalid keys with invalid_key", async () => {
      const store = await fresh();
      for (const key of ["", "../x", "a/../b", "/abs", "Upper", "a b", "-lead", "a/..", `a${"b".repeat(501)}`]) {
        await expect(store.head(key), key).rejects.toMatchObject({ code: "invalid_key" });
        await expect(store.putStream(key, chunked([Buffer.from("x")])), key).rejects.toBeInstanceOf(BlobStoreError);
      }
      await expect(store.get("../x")).rejects.toMatchObject({ code: "invalid_key" });
      await expect(store.delete("../x")).rejects.toMatchObject({ code: "invalid_key" });
    });

    it("head of a missing key is null", async () => {
      const store = await fresh();
      expect(await store.head("snap/missing.tar")).toBeNull();
    });

    it("getStream of a missing key rejects with not_found", async () => {
      const store = await fresh();
      await expect(store.getStream("snap/missing.tar")).rejects.toMatchObject({ code: "not_found" });
    });

    it("put/get/delete round-trip", async () => {
      const store = await fresh();
      await store.put("snap/b.bin", Buffer.from("abc"), { contentType: "application/octet-stream" });
      expect((await store.get("snap/b.bin")).toString()).toBe("abc");
      await store.delete("snap/b.bin");
      expect(await store.head("snap/b.bin")).toBeNull();
    });

    it("concurrent putStream calls to one key leave one intact object", async () => {
      const store = await fresh();
      const bodies = [Buffer.alloc(200_000, 1), Buffer.alloc(300_000, 2), Buffer.alloc(100_000, 3)];
      const results = await Promise.all(bodies.map((b) => store.putStream("snap/race.tar", chunked([b]))));
      const stored = await collect(await store.getStream("snap/race.tar"));
      const winner = bodies.findIndex((b) => b.equals(stored));
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(results[winner]?.sha256).toBe(createHash("sha256").update(stored).digest("hex"));
    });
  });
}
