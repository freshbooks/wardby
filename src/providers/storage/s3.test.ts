import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runBlobStoreContract } from "./blob-store-contract.js";
import { S3BlobStore, type S3ClientLike } from "./s3.js";

interface StoredObject {
  data: Buffer;
  updated: Date;
  contentType?: string;
  metadata: Record<string, string>;
}

class FakeS3Error extends Error {
  constructor(
    name: string,
    readonly status: number,
  ) {
    super(name);
    this.name = name;
  }
  get $metadata() {
    return { httpStatusCode: this.status };
  }
}

async function collect(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** In-memory stand-in for S3Client.send, including multipart bookkeeping so aborts are observable. */
export class FakeS3 implements S3ClientLike {
  readonly objects = new Map<string, StoredObject>();
  readonly multiparts = new Map<string, { key: string; parts: Map<number, Buffer>; contentType?: string }>();
  readonly commands: string[] = [];
  readonly aborted: string[] = [];
  readonly config = {
    endpoint: async () => ({ protocol: "https:", hostname: "s3.test", path: "/", port: undefined }),
    requestChecksumCalculation: async () => "WHEN_REQUIRED",
    requestHandler: {},
    forcePathStyle: true,
  };
  private nextUpload = 0;

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name;
    const input = command.input;
    this.commands.push(name);
    const key = input.Key as string;
    switch (name) {
      case "PutObjectCommand":
        this.objects.set(key, {
          data: await collect(input.Body),
          updated: new Date(),
          contentType: input.ContentType as string | undefined,
          metadata: { ...(input.Metadata as Record<string, string> | undefined) },
        });
        return { ETag: '"etag"' };
      case "CreateMultipartUploadCommand": {
        const uploadId = `u${this.nextUpload++}`;
        this.multiparts.set(uploadId, {
          key,
          parts: new Map(),
          contentType: input.ContentType as string | undefined,
        });
        return { UploadId: uploadId };
      }
      case "UploadPartCommand": {
        const upload = this.multiparts.get(input.UploadId as string);
        if (!upload) throw new FakeS3Error("NoSuchUpload", 404);
        upload.parts.set(input.PartNumber as number, await collect(input.Body));
        return { ETag: `"part${String(input.PartNumber)}"` };
      }
      case "CompleteMultipartUploadCommand": {
        const upload = this.multiparts.get(input.UploadId as string);
        if (!upload) throw new FakeS3Error("NoSuchUpload", 404);
        const ordered = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part);
        this.objects.set(upload.key, {
          data: Buffer.concat(ordered),
          updated: new Date(),
          contentType: upload.contentType,
          metadata: {},
        });
        this.multiparts.delete(input.UploadId as string);
        return { ETag: '"final"', Location: `https://s3.test/${key}` };
      }
      case "AbortMultipartUploadCommand":
        this.aborted.push(input.UploadId as string);
        this.multiparts.delete(input.UploadId as string);
        return {};
      case "CopyObjectCommand": {
        const found = this.objects.get(key);
        if (!found) throw new FakeS3Error("NoSuchKey", 404);
        const source = String(input.CopySource);
        if (source !== `${String(input.Bucket)}/${key}`) throw new Error(`unexpected copy source ${source}`);
        this.objects.set(key, {
          ...found,
          updated: new Date(),
          contentType: (input.ContentType as string | undefined) ?? found.contentType,
          metadata: { ...(input.Metadata as Record<string, string> | undefined) },
        });
        return {};
      }
      case "GetObjectCommand": {
        const found = this.objects.get(key);
        if (!found) throw new FakeS3Error("NoSuchKey", 404);
        return { Body: Readable.from([found.data], { objectMode: false }), ContentLength: found.data.length };
      }
      case "HeadObjectCommand": {
        const found = this.objects.get(key);
        if (!found) throw new FakeS3Error("NotFound", 404);
        return { ContentLength: found.data.length, LastModified: found.updated, Metadata: found.metadata };
      }
      case "DeleteObjectCommand":
        this.objects.delete(key);
        return {};
      default:
        throw new Error(`unexpected command ${name}`);
    }
  }
}

runBlobStoreContract("s3", async () => ({ store: new S3BlobStore(new FakeS3(), "bucket") }));

describe("S3BlobStore specifics", () => {
  it("records the sha256 as object metadata after a stream upload", async () => {
    const client = new FakeS3();
    const store = new S3BlobStore(client, "bucket");
    const { sha256 } = await store.putStream("snap/a.tar", Readable.from([Buffer.from("abc")]), {
      contentType: "application/x-tar",
    });
    expect(client.objects.get("snap/a.tar")?.metadata["x-wardby-sha256"]).toBe(sha256);
    expect(client.objects.get("snap/a.tar")?.contentType).toBe("application/x-tar");
    expect((await store.head("snap/a.tar"))?.sha256).toBe(sha256);
  });

  it("put records the sha256 too", async () => {
    const client = new FakeS3();
    const store = new S3BlobStore(client, "bucket");
    await store.put("snap/b.bin", Buffer.from("abc"));
    expect((await store.head("snap/b.bin"))?.sha256).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("aborts a multipart upload past maxBytes and leaves the previous object intact", async () => {
    const client = new FakeS3();
    const store = new S3BlobStore(client, "bucket");
    await store.put("snap/keep.tar", Buffer.from("previous contents"));
    const six = 6 * 1024 * 1024;
    const body = Readable.from([Buffer.alloc(six, 1), Buffer.alloc(six, 2), Buffer.alloc(six, 3)], {
      objectMode: false,
    });
    await expect(store.putStream("snap/keep.tar", body, { maxBytes: 2 * six })).rejects.toMatchObject({
      code: "blob_too_large",
    });
    expect(client.multiparts.size).toBe(0);
    expect(client.commands).toContain("CreateMultipartUploadCommand");
    expect((await store.get("snap/keep.tar")).toString()).toBe("previous contents");
  });

  it("round-trips a multi-part body", async () => {
    const client = new FakeS3();
    const store = new S3BlobStore(client, "bucket");
    const six = 6 * 1024 * 1024;
    const data = Buffer.concat([Buffer.alloc(six, 1), Buffer.alloc(six + 5, 2)]);
    const result = await store.putStream("snap/multi.tar", Readable.from([data], { objectMode: false }));
    expect(result.sizeBytes).toBe(data.length);
    expect(result.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect((await store.get("snap/multi.tar")).equals(data)).toBe(true);
    expect((await store.head("snap/multi.tar"))?.sha256).toBe(result.sha256);
  });

  it("signedUrl returns a presigned URL for the key", async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    });
    const store = new S3BlobStore(client, "bucket");
    const url = new URL(await store.signedUrl("snap/a.tar", { expiresSec: 60, method: "GET" }));
    expect(url.pathname).toContain("snap/a.tar");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("surfaces non-404 errors unchanged", async () => {
    const store = new S3BlobStore(
      {
        ...new FakeS3(),
        send: async () => {
          throw new FakeS3Error("InternalError", 500);
        },
      },
      "bucket",
    );
    await expect(store.head("snap/a.tar")).rejects.toThrow("InternalError");
  });
});
