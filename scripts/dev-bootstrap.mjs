#!/usr/bin/env node
/**
 * Local-dev bootstrap, driven by the Tiltfile (never run in production).
 *
 *   node scripts/dev-bootstrap.mjs env    generate the missing local secrets into .env.local
 *   node scripts/dev-bootstrap.mjs user   create (or repair) a dev admin login for self-hosted auth
 *
 * Both steps are idempotent and never print a secret: values go to owner-only
 * files and the log only names what was written and where.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envLocal = join(root, ".env.local");
const loginKeyFile = join(root, ".tilt", "dev-login-key");
const GENERATED = ["SECRET_APP_KEY", "AUTH_SIGNING_KEY", "AUTH_CREDENTIAL_HASH_KEY"];

function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

function writeSecretFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function bootstrapEnv() {
  // Same precedence the app uses: process env, then .env.local, then .env.
  const existing = { ...readEnvFile(join(root, ".env")), ...readEnvFile(envLocal), ...process.env };
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

/** Runs `wardby auth ...` through the CLI, which loads .env/.env.local itself. */
function auth(args) {
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

function bootstrapUser() {
  const subject = process.env.WARDBY_DEV_SUBJECT || "dev-admin";
  const users = JSON.parse(auth(["user", "list"]));
  const user = users.find((candidate) => candidate.principal.subject === subject);

  if (!user) {
    const created = JSON.parse(auth(["user", "create", "--subject", subject, "--role", "admin"]));
    writeSecretFile(loginKeyFile, `${created.loginKey}\n`);
    console.log(`dev-bootstrap: created admin user "${subject}"; login key written to .tilt/dev-login-key.`);
    return;
  }
  if (user.status !== "enabled") {
    throw new Error(`User "${subject}" is disabled. Set WARDBY_DEV_SUBJECT to another name or reset the database.`);
  }
  if (!user.roles.includes("admin")) auth(["user", "grant", "--subject", subject, "--role", "admin"]);
  if (!existsSync(loginKeyFile)) {
    // The key is only shown once at creation, so a lost file needs a fresh key.
    writeSecretFile(loginKeyFile, `${auth(["key", "create", "--subject", subject])}\n`);
    console.log(`dev-bootstrap: issued a new login key for "${subject}" into .tilt/dev-login-key.`);
    return;
  }
  console.log(`dev-bootstrap: admin user "${subject}" is ready (login key in .tilt/dev-login-key).`);
}

const step = process.argv[2];
try {
  if (step === "env") bootstrapEnv();
  else if (step === "user") bootstrapUser();
  else throw new Error("Usage: dev-bootstrap.mjs env|user");
} catch (error) {
  console.error(`dev-bootstrap: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
