/**
 * Storage seam — object/blob storage (run dependency snapshots today).
 *
 * Adapters: LocalBlobStore (filesystem), plus cloud object stores (GCS, S3).
 * Failures carry a stable `code` (see BlobStoreError).
 */

export interface BlobInfo {
  sizeBytes: number;
  /**
   * Present only when an adapter records it atomically with the content. Absence means "unknown", never
   * "verified": callers keep the authoritative digest themselves.
   */
  sha256?: string;
  updatedAt: Date;
}

export type BlobStoreErrorCode = "not_found" | "not_supported" | "invalid_key" | "blob_too_large";

/** An error with a stable machine-readable `code`; the message is the code unless more detail helps. */
export class BlobStoreError extends Error {
  constructor(
    readonly code: BlobStoreErrorCode,
    message: string = code,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BlobStoreError";
  }
}

export interface BlobStore {
  put(key: string, body: Buffer, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Pre-signed URL for direct client GET/PUT without proxying through the app. */
  signedUrl(key: string, opts: { expiresSec: number; method: "GET" | "PUT" }): Promise<string>;
  /**
   * Stream a body into the store, computing sha256 and the byte count on the way. Aborts and removes the
   * partial object (blob_too_large) when the body would exceed `maxBytes`.
   */
  putStream(
    key: string,
    body: NodeJS.ReadableStream,
    opts?: { contentType?: string; maxBytes?: number },
  ): Promise<{ sizeBytes: number; sha256: string }>;
  /** Rejects with code `not_found` when the key does not exist. */
  getStream(key: string): Promise<NodeJS.ReadableStream>;
  /** Null when the key does not exist. */
  head(key: string): Promise<BlobInfo | null>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,500}$/;

/** Throws invalid_key unless the key matches the allowed pattern and has no empty, `.` or `..` segment (so no `//` or trailing `/`). */
export function assertValidBlobKey(key: string): void {
  if (
    typeof key !== "string" ||
    !KEY_PATTERN.test(key) ||
    key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new BlobStoreError("invalid_key");
  }
}
