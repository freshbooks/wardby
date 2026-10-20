import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { test } from "vitest";
import { bootstrapEnv, pullSharedSecrets, removeEnvEntries, storedKeyIsUsable } from "./dev-bootstrap.mjs";

const NAMES = ["SECRET_APP_KEY", "AUTH_SIGNING_KEY", "AUTH_CREDENTIAL_HASH_KEY"];

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "wardby-dev-bootstrap-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const quietly = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

test("generates all three independent 64-hex keys into an owner-only .env.local", () =>
  withRoot((root) => {
    quietly(() => bootstrapEnv(root, {}));
    const file = join(root, ".env.local");
    const values = Object.fromEntries(
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    for (const name of NAMES) assert.match(values[name], /^[a-f0-9]{64}$/, name);
    assert.equal(new Set(NAMES.map((name) => values[name])).size, 3);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

test("never overwrites existing values and only appends the missing keys", () =>
  withRoot((root) => {
    const file = join(root, ".env.local");
    writeFileSync(file, "OPENAI_API_KEY=keep-me\nSECRET_APP_KEY=already-set", { mode: 0o644 });
    quietly(() => bootstrapEnv(root, {}));
    const text = readFileSync(file, "utf8");
    assert.match(text, /^OPENAI_API_KEY=keep-me\nSECRET_APP_KEY=already-set\n/);
    assert.equal(text.match(/^SECRET_APP_KEY=/gm).length, 1);
    assert.match(text, /^AUTH_SIGNING_KEY=[a-f0-9]{64}$/m);
    assert.match(text, /^AUTH_CREDENTIAL_HASH_KEY=[a-f0-9]{64}$/m);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

test("leaves the file untouched when every key is already set, in .env, .env.local or the shell", () =>
  withRoot((root) => {
    writeFileSync(join(root, ".env"), "SECRET_APP_KEY=a\n");
    writeFileSync(join(root, ".env.local"), "AUTH_SIGNING_KEY=b\n");
    quietly(() => bootstrapEnv(root, { AUTH_CREDENTIAL_HASH_KEY: "c" }));
    assert.equal(readFileSync(join(root, ".env.local"), "utf8"), "AUTH_SIGNING_KEY=b\n");
  }));

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----";
const fakeAccess =
  (calls = []) =>
  (project, secret) => {
    calls.push([project, secret]);
    if (secret.endsWith("github-app-private-key")) return `${PEM}\n`;
    return `value-of-${secret}\n`;
  };

test("does nothing when WARDBY_GSM_PULL=0", () =>
  withRoot((root) => {
    const calls = [];
    quietly(() => pullSharedSecrets(root, { WARDBY_GSM_PULL: "0" }, fakeAccess(calls)));
    assert.equal(calls.length, 0);
    assert.throws(() => readFileSync(join(root, ".env.local")));
  }));

test("uses the default project when WARDBY_GSM_PROJECT is unset, and warns instead of failing", () =>
  withRoot((root) => {
    const calls = [];
    quietly(() => pullSharedSecrets(root, {}, fakeAccess(calls)));
    assert.equal(calls[0][0], "freshbooks-builds");

    const file = join(root, ".env.local");
    writeFileSync(file, "KEEP=1\n");
    const warn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
      pullSharedSecrets(root, {}, () => {
        throw new Error("gcloud could not read x: PERMISSION_DENIED");
      });
    } finally {
      console.warn = warn;
    }
    assert.match(warnings[0], /skipped the shared secrets pull from freshbooks-builds/);
    assert.equal(readFileSync(file, "utf8"), "KEEP=1\n");
  }));

test("pulls the five shared secrets, quoting the multi-line key, into an owner-only .env.local", () =>
  withRoot((root) => {
    const calls = [];
    quietly(() => pullSharedSecrets(root, { WARDBY_GSM_PROJECT: "my-proj" }, fakeAccess(calls)));
    assert.deepEqual(
      calls.map(([project, secret]) => `${project}/${secret}`),
      [
        "my-proj/wardby-dev-github-app-id",
        "my-proj/wardby-dev-github-app-private-key",
        "my-proj/wardby-dev-github-app-client-id",
        "my-proj/wardby-dev-github-app-client-secret",
        "my-proj/wardby-dev-anthropic-api-key",
      ],
    );
    const file = join(root, ".env.local");
    const parsed = parseEnv(readFileSync(file, "utf8"));
    assert.equal(parsed.GITHUB_APP_ID, "value-of-wardby-dev-github-app-id");
    assert.equal(parsed.GITHUB_APP_PRIVATE_KEY, PEM);
    assert.equal(parsed.ANTHROPIC_API_KEY, "value-of-wardby-dev-anthropic-api-key");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

test("replaces only its own entries, including an old multi-line key, and keeps everything else", () =>
  withRoot((root) => {
    const file = join(root, ".env.local");
    writeFileSync(
      file,
      `KEEP_A=1\nGITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nOLD\n-----END RSA PRIVATE KEY-----"\nGITHUB_APP_ID=old\nKEEP_B=2\nWARDBY_GSM_PROJECT=my-proj\n`,
    );
    quietly(() => pullSharedSecrets(root, {}, fakeAccess()));
    const parsed = parseEnv(readFileSync(file, "utf8"));
    assert.equal(parsed.KEEP_A, "1");
    assert.equal(parsed.KEEP_B, "2");
    assert.equal(parsed.GITHUB_APP_ID, "value-of-wardby-dev-github-app-id");
    assert.equal(parsed.GITHUB_APP_PRIVATE_KEY, PEM);
    assert.equal(readFileSync(file, "utf8").match(/^GITHUB_APP_ID=/gm).length, 1);
  }));

test("is idempotent and honours WARDBY_GSM_SECRET_PREFIX", () =>
  withRoot((root) => {
    const calls = [];
    const env = { WARDBY_GSM_PROJECT: "p", WARDBY_GSM_SECRET_PREFIX: "team-" };
    quietly(() => pullSharedSecrets(root, env, fakeAccess(calls)));
    const first = readFileSync(join(root, ".env.local"), "utf8");
    quietly(() => pullSharedSecrets(root, env, fakeAccess(calls)));
    assert.equal(readFileSync(join(root, ".env.local"), "utf8"), first);
    assert.equal(calls[0][1], "team-github-app-id");
  }));

test("fails without printing a value and leaves .env.local untouched when a secret cannot be read", () =>
  withRoot((root) => {
    const file = join(root, ".env.local");
    writeFileSync(file, "KEEP=1\n");
    const failing = (_project, secret) => {
      if (secret.endsWith("client-id")) throw new Error(`gcloud could not read ${secret}: NOT_FOUND`);
      return "value\n";
    };
    assert.throws(() => pullSharedSecrets(root, { WARDBY_GSM_PROJECT: "p" }, failing), /NOT_FOUND/);
    assert.equal(readFileSync(file, "utf8"), "KEEP=1\n");
  }));

test("rejects an empty secret and a value that .env.local cannot hold", () =>
  withRoot((root) => {
    assert.throws(() => pullSharedSecrets(root, { WARDBY_GSM_PROJECT: "p" }, () => "  \n"), /is empty/);
    assert.throws(() => pullSharedSecrets(root, { WARDBY_GSM_PROJECT: "p" }, () => 'a"b'), /quote or backslash/);
  }));

test("removeEnvEntries keeps unrelated multi-line values intact", () => {
  const text = `A="x\ny"\nB=1\nC='p\nq'\n`;
  assert.equal(removeEnvEntries(text, new Set(["B"])), `A="x\ny"\nC='p\nq'\n`);
});

const KEY_ID = "0b6f5c1e-8a3d-4f27-9d2e-5a1c7e9b4d30";
const stored = `wbk_${KEY_ID}.${"A".repeat(43)}\n`;
const future = new Date(Date.now() + 86_400_000).toISOString();

test("a stored key is usable only if it is this subject's, unrevoked and unexpired", () => {
  assert.equal(storedKeyIsUsable(stored, [{ keyId: KEY_ID, expiresAt: future, revokedAt: null }]), true);
  // another subject's key (not in this subject's list), or garbage
  assert.equal(storedKeyIsUsable(stored, [{ keyId: "other", expiresAt: future, revokedAt: null }]), false);
  assert.equal(storedKeyIsUsable("not-a-key", [{ keyId: KEY_ID, expiresAt: future, revokedAt: null }]), false);
  // revoked, or expired
  assert.equal(
    storedKeyIsUsable(stored, [{ keyId: KEY_ID, expiresAt: future, revokedAt: new Date().toISOString() }]),
    false,
  );
  assert.equal(
    storedKeyIsUsable(stored, [
      { keyId: KEY_ID, expiresAt: new Date(Date.now() - 1000).toISOString(), revokedAt: null },
    ]),
    false,
  );
  assert.equal(storedKeyIsUsable(stored, []), false);
});
