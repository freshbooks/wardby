#!/usr/bin/env node
/**
 * Local-dev bootstrap, driven by the Tiltfile (never run in production).
 *
 *   node scripts/dev-bootstrap.mjs env    generate the missing local secrets into .env.local
 *   node scripts/dev-bootstrap.mjs user   create (or repair) a dev admin login for self-hosted auth
 *   node scripts/dev-bootstrap.mjs secrets  pull the shared dev secrets from Google Secret Manager
 *                                         into .env.local (WARDBY_GSM_PULL=0 skips it)
 *
 * Both steps are idempotent and never print a secret: values go to owner-only
 * files and the log only names what was written and where.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = ["SECRET_APP_KEY", "AUTH_SIGNING_KEY", "AUTH_CREDENTIAL_HASH_KEY"];

function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

function writeSecretFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  // Write a sibling file, then rename it into place: a crash or Ctrl-C mid-write must not leave
  // .env.local truncated (it holds the generated SECRET_APP_KEY), and Tilt must never read a partial file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Generates the missing secrets into `<root>/.env.local`; existing values are never touched. */
export function bootstrapEnv(root = defaultRoot, processEnv = process.env) {
  const envLocal = join(root, ".env.local");
  // Same precedence the app uses: process env, then .env.local, then .env.
  const existing = { ...readEnvFile(join(root, ".env")), ...readEnvFile(envLocal), ...processEnv };
  const missing = GENERATED.filter((name) => !existing[name]?.trim());
  if (missing.length === 0) {
    console.log("dev-bootstrap: SECRET_APP_KEY and auth keys already set, nothing to do.");
    return;
  }
  // Independently generated: the app refuses SECRET_APP_KEY === AUTH_CREDENTIAL_HASH_KEY.
  const lines = missing.map((name) => `${name}=${randomBytes(32).toString("hex")}`);
  const current = existsSync(envLocal) ? readFileSync(envLocal, "utf8") : "";
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  writeSecretFile(envLocal, `${current}${separator}${lines.join("\n")}\n`);
  console.log(`dev-bootstrap: generated ${missing.join(", ")} into .env.local (owner-only).`);
}

// Secret Manager entry (after the prefix) -> the variable it fills in .env.local.
const SHARED_SECRETS = [
  ["github-app-id", "GITHUB_APP_ID"],
  ["github-app-private-key", "GITHUB_APP_PRIVATE_KEY"],
  ["github-app-client-id", "GITHUB_APP_CLIENT_ID"],
  ["github-app-client-secret", "GITHUB_APP_CLIENT_SECRET"],
  ["anthropic-api-key", "ANTHROPIC_API_KEY"],
];
const DEFAULT_SECRET_PREFIX = "wardby-dev-";
// Where the shared dev secrets live; WARDBY_GSM_PROJECT overrides it.
const DEFAULT_GSM_PROJECT = "freshbooks-builds";

/** Drops the given variables from dotenv text, including quoted values that span several lines. */
export function removeEnvEntries(text, names) {
  const lines = text.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = i;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\r?$/.exec(lines[i]);
    if (match) {
      // A quoted value may continue over several lines; those lines belong to this entry, kept or not.
      const quote = match[2][0];
      if ((quote === '"' || quote === "'" || quote === "`") && match[2].indexOf(quote, 1) === -1) {
        while (i + 1 < lines.length && !lines[i + 1].includes(quote)) i += 1;
        i = Math.min(i + 1, lines.length - 1); // the line holding the closing quote
      }
      if (names.has(match[1])) continue;
    }
    kept.push(...lines.slice(start, i + 1));
  }
  return kept.join("\n");
}

function formatEnvValue(name, value) {
  if (value.includes('"') || value.includes("\\")) {
    throw new Error(`the value for ${name} contains a quote or backslash, which .env.local cannot hold safely.`);
  }
  return /[\r\n\s#'`]/.test(value) ? `"${value}"` : value;
}

function accessGcloudSecret(project, secret) {
  const result = spawnSync(
    "gcloud",
    ["secrets", "versions", "access", "latest", "--secret", secret, "--project", project],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 },
  );
  if (result.error) throw new Error(`could not run gcloud: ${result.error.message}`);
  // stderr carries the error text, never a secret value.
  if (result.status !== 0) throw new Error(`gcloud could not read ${secret}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * Pulls the shared dev secrets from Google Secret Manager into `<root>/.env.local`. The project is
 * WARDBY_GSM_PROJECT or the default above; WARDBY_GSM_PULL=0 skips the pull. A failure on the default
 * project only warns, an explicit WARDBY_GSM_PROJECT fails. Values travel in memory only and are never
 * logged or passed as arguments; the log names the variables written.
 */
export function pullSharedSecrets(root = defaultRoot, processEnv = process.env, access = accessGcloudSecret) {
  const envLocal = join(root, ".env.local");
  const settings = { ...readEnvFile(join(root, ".env")), ...readEnvFile(envLocal), ...processEnv };
  if (settings.WARDBY_GSM_PULL?.trim() === "0") {
    console.log("dev-bootstrap: WARDBY_GSM_PULL=0, skipping the shared secrets pull.");
    return;
  }
  const explicitProject = settings.WARDBY_GSM_PROJECT?.trim();
  const project = explicitProject || DEFAULT_GSM_PROJECT;
  const prefix = settings.WARDBY_GSM_SECRET_PREFIX?.trim() || DEFAULT_SECRET_PREFIX;
  let entries;
  try {
    entries = SHARED_SECRETS.map(([suffix, variable]) => {
      const value = access(project, `${prefix}${suffix}`).trim();
      if (!value) throw new Error(`${prefix}${suffix} is empty in Secret Manager project ${project}.`);
      return [variable, formatEnvValue(variable, value)];
    });
  } catch (error) {
    // The default project is only a convenience: without gcloud access, keep whatever .env.local holds.
    if (explicitProject) throw error;
    // Fixed text on purpose: nothing derived from the environment or from gcloud's output is logged.
    console.warn(
      `dev-bootstrap: skipped the shared secrets pull from ${DEFAULT_GSM_PROJECT}: gcloud could not read them. ` +
        "Sign in with `gcloud auth login` and check access, or set WARDBY_GSM_PULL=0 to silence this.",
    );
    return;
  }
  const current = existsSync(envLocal) ? readFileSync(envLocal, "utf8") : "";
  const kept = removeEnvEntries(current, new Set(entries.map(([variable]) => variable)));
  const separator = kept === "" || kept.endsWith("\n") ? "" : "\n";
  const next = `${kept}${separator}${entries.map(([variable, value]) => `${variable}=${value}`).join("\n")}\n`;
  if (next !== current) writeSecretFile(envLocal, next);
  // Unchanged content skips the write above, so harden an older, looser file here without rewriting it.
  // Only touch the mode when it is wrong: Tilt watches .env.local, and even a no-op chmod counts as a
  // change that reloads the Tiltfile, which runs this pull again, forever.
  else if ((statSync(envLocal).mode & 0o777) !== 0o600) chmodSync(envLocal, 0o600);
  console.log(
    `dev-bootstrap: pulled ${entries.map(([variable]) => variable).join(", ")} from Secret Manager into .env.local (owner-only).`,
  );
}

/** Runs `wardby auth ...` through the CLI, which loads .env/.env.local itself. */
function auth(root, args) {
  const result = spawnSync(
    join(root, "node_modules", ".bin", "tsx"),
    ["--conditions=wardby-source", "src/cli.ts", "auth", ...args],
    { cwd: root, env: process.env, encoding: "utf8" },
  );
  if (result.status !== 0) {
    // stderr carries the error message, never a secret.
    throw new Error(`auth ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

/** True when the stored login key is one of this subject's keys and is neither revoked nor expired. */
export function storedKeyIsUsable(storedKey, keys, now = new Date()) {
  const keyId = /_([a-f0-9-]{36})\./.exec(storedKey.trim())?.[1];
  if (!keyId) return false;
  const key = keys.find((candidate) => candidate.keyId === keyId);
  return Boolean(key && !key.revokedAt && new Date(key.expiresAt) > now);
}

/**
 * Short fingerprint of AUTH_CREDENTIAL_HASH_KEY (same precedence as the app). Login keys are stored as an
 * HMAC under that key, so a key file written under another value no longer signs in. Never the key itself.
 */
export function hashKeyFingerprint(root = defaultRoot, processEnv = process.env) {
  const settings = { ...readEnvFile(join(root, ".env")), ...readEnvFile(join(root, ".env.local")), ...processEnv };
  const key = settings.AUTH_CREDENTIAL_HASH_KEY?.trim();
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : "";
}

function bootstrapUser(root = defaultRoot) {
  const loginKeyFile = join(root, ".tilt", "dev-login-key");
  const fingerprintFile = join(root, ".tilt", "dev-login-key.fingerprint");
  const fingerprint = hashKeyFingerprint(root);
  const subject = process.env.WARDBY_DEV_SUBJECT || "dev-admin";
  const users = JSON.parse(auth(root, ["user", "list"]));
  const user = users.find((candidate) => candidate.principal.subject === subject);

  if (!user) {
    const created = JSON.parse(auth(root, ["user", "create", "--subject", subject, "--role", "admin"]));
    writeSecretFile(loginKeyFile, `${created.loginKey}\n`);
    writeSecretFile(fingerprintFile, `${fingerprint}\n`);
    console.log(`dev-bootstrap: created admin user "${subject}"; login key written to .tilt/dev-login-key.`);
    return;
  }
  if (user.status !== "enabled") {
    throw new Error(`User "${subject}" is disabled. Set WARDBY_DEV_SUBJECT to another name or reset the database.`);
  }
  if (!user.roles.includes("admin")) auth(root, ["user", "grant", "--subject", subject, "--role", "admin"]);
  // A key file left over from another subject, or revoked/expired since, is replaced. The key is only
  // shown once at creation, so a replacement means issuing a new one.
  const keys = JSON.parse(auth(root, ["key", "list", "--subject", subject]));
  // A key issued under a different AUTH_CREDENTIAL_HASH_KEY (for example after .env.local was recreated) is
  // still listed as valid but no longer signs in, so the fingerprint written with the key must match too.
  const sameHashKey = existsSync(fingerprintFile) && readFileSync(fingerprintFile, "utf8").trim() === fingerprint;
  if (!existsSync(loginKeyFile) || !sameHashKey || !storedKeyIsUsable(readFileSync(loginKeyFile, "utf8"), keys)) {
    writeSecretFile(loginKeyFile, `${auth(root, ["key", "create", "--subject", subject])}\n`);
    writeSecretFile(fingerprintFile, `${fingerprint}\n`);
    console.log(`dev-bootstrap: issued a new login key for "${subject}" into .tilt/dev-login-key.`);
    return;
  }
  console.log(`dev-bootstrap: admin user "${subject}" is ready (login key in .tilt/dev-login-key).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const step = process.argv[2];
  if (step === "secrets") {
    try {
      pullSharedSecrets();
    } catch {
      // Fixed text on purpose: the error carries the secret name, which comes from the environment.
      console.error(
        "dev-bootstrap: the shared secrets pull failed. Read one secret by hand to see why: " +
          "gcloud secrets versions access latest --secret=<prefix>github-app-id --project=<project>",
      );
      process.exit(1);
    }
  } else {
    try {
      if (step === "env") bootstrapEnv();
      else if (step === "user") bootstrapUser();
      else throw new Error("Usage: dev-bootstrap.mjs env|user|secrets");
    } catch (error) {
      console.error(`dev-bootstrap: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }
}
