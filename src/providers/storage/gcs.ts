import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Storage } from "@google-cloud/storage";
import { collectStream, createByteMeter } from "./meter.js";
import { assertValidBlobKey, BlobStoreError, type BlobInfo, type BlobStore } from "./types.js";

/** The slice of a GCS File the adapter uses (the real `File` satisfies it; tests supply an in-memory fake). */
export interface GcsFileLike {
  createWriteStream(options?: { resumable?: boolean; contentType?: string }): Writable;
  createReadStream(): Readable;
  getMetadata(): Promise<
    [{ size?: string | number; updated?: string; metadata?: Record<string, unknown> }, ...unknown[]]
  >;
  save(data: Buffer, options?: { resumable?: boolean; contentType?: string }): Promise<unknown>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  getSignedUrl(config: { version: "v4"; action: "read" | "write"; expires: number }): Promise<[string]>;
}

export interface GcsBucketLike {
  file(name: string): GcsFileLike;
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 404;
}

/**
 * Google Cloud Storage blob store. Credentials come from Application Default Credentials (Workload Identity on
 * GKE); no key files. Uploads are single-request (non-resumable), so an upload that is destroyed before it
 * finishes never creates or replaces an object.
 */
export class GcsBlobStore implements BlobStore {
  constructor(private readonly bucket: GcsBucketLike) {}

  /** Build a store over `bucketName` using Application Default Credentials. */
  static forBucket(bucketName: string): GcsBlobStore {
    return new GcsBlobStore(new Storage().bucket(bucketName));
  }

  private file(key: string): GcsFileLike {
    assertValidBlobKey(key);
    return this.bucket.file(key);
  }

  async put(key: string, body: Buffer, opts?: { contentType?: string }): Promise<void> {
    await this.file(key).save(body, { resumable: false, contentType: opts?.contentType });
  }

  async get(key: string): Promise<Buffer> {
    return collectStream(await this.getStream(key));
  }

  async delete(key: string): Promise<void> {
    await this.file(key).delete({ ignoreNotFound: true });
  }

  async signedUrl(key: string, opts: { expiresSec: number; method: "GET" | "PUT" }): Promise<string> {
    const [url] = await this.file(key).getSignedUrl({
      version: "v4",
      action: opts.method === "GET" ? "read" : "write",
      expires: Date.now() + opts.expiresSec * 1000,
    });
    return url;
  }

  async putStream(
    key: string,
    body: NodeJS.ReadableStream,
    opts?: { contentType?: string; maxBytes?: number },
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const file = this.file(key);
    const meter = createByteMeter(opts?.maxBytes);
    // pipeline destroys every stream (including the GCS write stream) on failure, which aborts the HTTP request
    // before the object is finalized.
    await pipeline(body, meter.stream, file.createWriteStream({ resumable: false, contentType: opts?.contentType }));
    return { sizeBytes: meter.size(), sha256: meter.digest() };
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    const file = this.file(key);
    // createReadStream reports a missing object asynchronously; look first so callers get a typed not_found.
    if ((await this.head(key)) === null) throw new BlobStoreError("not_found");
    return file.createReadStream();
  }

  async head(key: string): Promise<BlobInfo | null> {
    try {
      const [metadata] = await this.file(key).getMetadata();
      return { sizeBytes: Number(metadata.size ?? 0), updatedAt: new Date(metadata.updated ?? 0) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
