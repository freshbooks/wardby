import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { bootstrapEnv, storedKeyIsUsable } from "./dev-bootstrap.mjs";

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
