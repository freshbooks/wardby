import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createByteMeter } from "./meter.js";
import { assertValidBlobKey, BlobStoreError, type BlobInfo, type BlobStore } from "./types.js";

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Filesystem blob store rooted at one directory. Writes go to a temp file in the target directory, then rename (atomic). */
export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    assertValidBlobKey(key);
    return join(this.root, key);
  }

  private tempPathFor(path: string): string {
    return join(dirname(path), `.tmp-${randomUUID()}`);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = this.tempPathFor(path);
    try {
      await writeFile(temp, body);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if (isNotFound(error)) throw new BlobStoreError("not_found", "not_found", { cause: error });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async signedUrl(key: string, _opts: { expiresSec: number; method: "GET" | "PUT" }): Promise<string> {
    assertValidBlobKey(key);
    throw new BlobStoreError("not_supported", "not_supported: the local blob store has no signed URLs");
  }

  async putStream(
    key: string,
    body: NodeJS.ReadableStream,
    opts?: { contentType?: string; maxBytes?: number },
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = this.tempPathFor(path);
    const meter = createByteMeter(opts?.maxBytes);
    try {
      await pipeline(body, meter.stream, createWriteStream(temp));
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { sizeBytes: meter.size(), sha256: meter.digest() };
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    const path = this.pathFor(key);
    try {
      await stat(path);
    } catch (error) {
      if (isNotFound(error)) throw new BlobStoreError("not_found", "not_found", { cause: error });
      throw error;
    }
    return createReadStream(path);
  }

  async head(key: string): Promise<BlobInfo | null> {
    try {
      const info = await stat(this.pathFor(key));
      return { sizeBytes: info.size, updatedAt: info.mtime };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
