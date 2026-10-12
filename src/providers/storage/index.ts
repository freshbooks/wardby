import { GcsBlobStore } from "./gcs.js";
import { LocalBlobStore } from "./local.js";
import { S3BlobStore } from "./s3.js";
import type { BlobStore } from "./types.js";

export type BlobStoreConfig =
  | { kind: "local"; localDir: string }
  | { kind: "gcs"; bucket: string }
  | { kind: "s3"; bucket: string; region: string; endpoint?: string };

/** Build the configured blob store. Cloud adapters take credentials from the environment's default chain. */
export function createBlobStore(config: BlobStoreConfig): BlobStore {
  switch (config.kind) {
    case "local":
      return new LocalBlobStore(config.localDir);
    case "gcs":
      return GcsBlobStore.forBucket(config.bucket);
    case "s3":
      return S3BlobStore.forBucket(config);
  }
}
