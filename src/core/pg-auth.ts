/**
 * How wardby authenticates to Postgres (DATABASE_AUTH).
 *
 * `password` (default): the URL carries everything, exactly as before — pgConnectionConfig returns
 * `{ connectionString }` and nothing else, so unset DATABASE_AUTH changes no connection.
 *
 * `rds-iam`: Amazon RDS IAM database authentication. The password is a short-lived token signed
 * with the workload's AWS credentials (EKS Pod Identity via the default provider chain), minted per
 * new connection and reused for RDS_IAM_TOKEN_REUSE_MS — tokens are valid 15 minutes, and only for
 * establishing a connection, so an open connection outlives its token. TLS with certificate
 * verification is mandatory: the URL must say sslmode=verify-full and name the RDS CA bundle in
 * sslrootcert.
 *
 * Under rds-iam the URL is parsed here into explicit fields rather than passed as connectionString:
 * pg merges a parsed connection string over explicit config, and a password-less URL would replace
 * the token function with an empty password.
 *
 * Refusals never include the URL, its credentials, or a token.
 */
import { readFileSync } from "node:fs";
import { Signer } from "@aws-sdk/rds-signer";
import type { ClientConfig } from "pg";

export type DatabaseAuth = "password" | "rds-iam";
export const DATABASE_AUTH_ERROR = "database_auth_invalid";
export const RDS_IAM_TOKEN_REUSE_MS = 600_000;

export interface TokenSigner {
  getAuthToken(): Promise<string>;
}

export interface PgAuthOptions {
  env?: NodeJS.ProcessEnv;
  makeSigner?: (p: { hostname: string; port: number; username: string; region: string }) => TokenSigner;
  now?: () => number;
  readFile?: (path: string) => string;
}

export function databaseAuthFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseAuth {
  const value = env.DATABASE_AUTH?.trim() || "password";
  if (value === "password" || value === "rds-iam") return value;
  throw new Error(`${DATABASE_AUTH_ERROR}: DATABASE_AUTH must be "password" or "rds-iam" (found "${value}")`);
}

function refuse(detail: string): never {
  throw new Error(`${DATABASE_AUTH_ERROR}: DATABASE_AUTH=rds-iam ${detail}`);
}

/** One token at a time: concurrent connects share a signing call; a failure is never cached. */
export function cachedToken(
  signer: TokenSigner,
  now: () => number = Date.now,
  reuseMs: number = RDS_IAM_TOKEN_REUSE_MS,
): () => Promise<string> {
  let token: string | undefined;
  let mintedAt = 0;
  let inflight: Promise<string> | undefined;
  return async () => {
    if (token !== undefined && now() - mintedAt < reuseMs) return token;
    if (!inflight) {
      const startedAt = now();
      inflight = signer
        .getAuthToken()
        .then((fresh) => {
          token = fresh;
          mintedAt = startedAt;
          return fresh;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  };
}

function decode(component: string, what: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    return refuse(`needs a correctly percent-encoded ${what} in DATABASE_URL`);
  }
}

export function pgConnectionConfig(url: string, auth: DatabaseAuth, options: PgAuthOptions = {}): ClientConfig {
  if (auth === "password") return { connectionString: url };
  const env = options.env ?? process.env;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse("needs a valid postgresql:// DATABASE_URL");
  }
  if (parsed.password) refuse("takes no password in DATABASE_URL (the IAM token is the password)");
  const user = decode(parsed.username, "user name");
  if (!user) refuse("needs a user name in DATABASE_URL (the database user mapped to the IAM role)");
  const region = env.DATABASE_AWS_REGION?.trim() || env.AWS_REGION?.trim();
  if (!region) refuse("needs AWS_REGION (or DATABASE_AWS_REGION)");
  const rootCert = parsed.searchParams.get("sslrootcert");
  if (parsed.searchParams.get("sslmode") !== "verify-full" || !rootCert) {
    refuse("needs sslmode=verify-full and sslrootcert=<path to the RDS CA bundle> in DATABASE_URL");
  }
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 5432;
  const database = decode(parsed.pathname.replace(/^\//, ""), "database name") || undefined;
  const makeSigner = options.makeSigner ?? ((params) => new Signer(params));
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  return {
    host,
    port,
    user,
    database,
    password: cachedToken(makeSigner({ hostname: host, port, username: user, region }), options.now),
    ssl: { ca: readFile(rootCert), rejectUnauthorized: true, servername: host },
  };
}
