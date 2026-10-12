import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { BlobStoreError } from "./types.js";

export interface ByteMeter {
  stream: Transform;
  /** Bytes seen so far. */
  size(): number;
  /** The blob_too_large error, once the limit tripped. */
  limitError(): BlobStoreError | undefined;
  /** Finish the hash; call once, after the body has ended. */
  digest(): string;
}

/** A passthrough that counts bytes (normalizing string chunks), hashes them, and fails with blob_too_large past `maxBytes`. */
export function createByteMeter(maxBytes: number | undefined): ByteMeter {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let tooLarge: BlobStoreError | undefined;
  const stream = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (maxBytes !== undefined && sizeBytes > maxBytes) {
        tooLarge = new BlobStoreError("blob_too_large", `blob_too_large: more than ${maxBytes} bytes`);
        callback(tooLarge);
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    },
  });
  return { stream, size: () => sizeBytes, limitError: () => tooLarge, digest: () => hash.digest("hex") };
}

export async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}
