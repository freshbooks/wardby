import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { collectStream, createByteMeter } from "./meter.js";
import { assertValidBlobKey, BlobStoreError, type BlobInfo, type BlobStore } from "./types.js";

/** The slice of S3Client the adapter uses (the real client satisfies it; tests supply an in-memory fake). */
export interface S3ClientLike {
  send(command: object): Promise<unknown>;
  readonly config: unknown;
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
}

/** A missing key only: NoSuchBucket and other 404-class failures must surface, not look like an empty store. */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  if (name === "NoSuchKey") return true;
  // HeadObject has no body, so a missing key arrives as a bare NotFound.
  return name === "NotFound" && statusOf(error) === 404;
}

/**
 * S3-compatible blob store (AWS S3, MinIO via `endpoint`). Credentials come from the default AWS credential
 * chain (Pod Identity on EKS). Streamed uploads use multipart for large bodies; S3 only exposes an object once the
 * upload completes, so an aborted upload never replaces the previous object.
 */
export class S3BlobStore implements BlobStore {
  constructor(
    private readonly client: S3ClientLike,
    private readonly bucket: string,
  ) {}

  /** Build a store using the default credential chain. A custom `endpoint` (MinIO) switches to path-style addressing. */
  static forBucket(settings: { bucket: string; region: string; endpoint?: string }): S3BlobStore {
    const client = new S3Client({
      region: settings.region,
      // Default CRC32 checksums break presigned PUTs (empty-body checksum in the URL) and many S3-compatible endpoints.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      ...(settings.endpoint ? { endpoint: settings.endpoint, forcePathStyle: true } : {}),
    });
    return new S3BlobStore(client, settings.bucket);
  }

  private keyed(key: string): { Bucket: string; Key: string } {
    assertValidBlobKey(key);
    return { Bucket: this.bucket, Key: key };
  }

  async put(key: string, body: Buffer, opts?: { contentType?: string }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        ...this.keyed(key),
        Body: body,
        ContentType: opts?.contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    return collectStream(await this.getStream(key));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand(this.keyed(key)));
  }

  async signedUrl(key: string, opts: { expiresSec: number; method: "GET" | "PUT" }): Promise<string> {
    const params = this.keyed(key);
    const command = opts.method === "GET" ? new GetObjectCommand(params) : new PutObjectCommand(params);
    return getSignedUrl(this.client as unknown as S3Client, command, { expiresIn: opts.expiresSec });
  }

  async putStream(
    key: string,
    body: NodeJS.ReadableStream,
    opts?: { contentType?: string; maxBytes?: number },
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const target = this.keyed(key);
    const meter = createByteMeter(opts?.maxBytes);
    const upload = new Upload({
      client: this.client as unknown as S3Client,
      params: { ...target, Body: meter.stream, ContentType: opts?.contentType },
      leavePartsOnError: false,
    });
    const uploading = upload.done();
    uploading.catch(() => undefined); // observed below; avoids an unhandled rejection if the pipeline fails first
    try {
      await Promise.all([pipeline(body, meter.stream), uploading]);
    } catch (error) {
      // Abort any in-flight multipart upload so no parts (and no object) are left behind; the previous object, if any,
      // is untouched because S3 publishes an object only when the upload completes.
      await upload.abort().catch(() => undefined);
      await uploading.catch(() => undefined);
      throw meter.limitError() ?? error;
    }
    return { sizeBytes: meter.size(), sha256: meter.digest() };
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    try {
      const result = (await this.client.send(new GetObjectCommand(this.keyed(key)))) as GetObjectCommandOutput;
      return result.Body as unknown as NodeJS.ReadableStream;
    } catch (error) {
      if (isNotFound(error)) throw new BlobStoreError("not_found", "not_found", { cause: error });
      throw error;
    }
  }

  async head(key: string): Promise<BlobInfo | null> {
    try {
      const result = (await this.client.send(new HeadObjectCommand(this.keyed(key)))) as HeadObjectCommandOutput;
      return { sizeBytes: Number(result.ContentLength ?? 0), updatedAt: result.LastModified ?? new Date(0) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
