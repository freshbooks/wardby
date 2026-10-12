import { LocalBlobStore } from "./local.js";
import { BlobStoreError, type BlobStore } from "./types.js";

export type BlobStoreConfig = { kind: "local"; localDir: string } | { kind: "gcs" | "s3" };

/** Build the configured blob store. The GCS and S3 adapters are not available yet. */
export function createBlobStore(config: BlobStoreConfig): BlobStore {
  switch (config.kind) {
    case "local":
      return new LocalBlobStore(config.localDir);
    default:
      throw new BlobStoreError("not_supported", `not_supported: the ${config.kind} blob store is not available yet`);
  }
}
