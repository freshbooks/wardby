#!/usr/bin/env node
// Prints DATABASE_URL with a fresh RDS IAM token as its password, for the URL-only tools the
// migration Job runs (prisma migrate deploy, dbos schema). The token is valid for 15 minutes of
// new connections. Never log the output: it is a credential.
//
// Deliberately duplicates three checks from src/core/pg-auth.ts (postgres scheme, no password in
// the URL, region from DATABASE_AWS_REGION then AWS_REGION) because the migration image has no
// dist/. Keep the wording identical to pg-auth.ts so operators see one vocabulary. Errors never
// include the URL.
import { pathToFileURL } from "node:url";

function refuse(detail) {
  throw new Error(`database_auth_invalid: DATABASE_AUTH=rds-iam ${detail}`);
}

export function tokenUrl(url, token) {
  const out = new URL(url);
  out.password = encodeURIComponent(token);
  return out.toString();
}

export async function main(env = process.env, makeSigner) {
  let url;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    return refuse("needs a valid postgresql:// DATABASE_URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    refuse("needs a postgresql:// (or postgres://) DATABASE_URL");
  }
  if (url.password) refuse("takes no password in DATABASE_URL (the IAM token is the password)");
  const region = env.DATABASE_AWS_REGION?.trim() || env.AWS_REGION?.trim();
  if (!region) refuse("needs AWS_REGION (or DATABASE_AWS_REGION)");
  const params = {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    username: decodeURIComponent(url.username),
    region,
  };
  const signer = makeSigner ? makeSigner(params) : new (await import("@aws-sdk/rds-signer")).Signer(params);
  return tokenUrl(env.DATABASE_URL, await signer.getAuthToken());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (out) => process.stdout.write(out),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
