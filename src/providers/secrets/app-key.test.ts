import { describe, it, expect } from "vitest";
import { AppKeySecretCipher } from "./app-key.js";

const key = "0".repeat(64); // 32 bytes hex

describe("AppKeySecretCipher", () => {
  it("round-trips and never emits plaintext", async () => {
    const c = new AppKeySecretCipher(key);
    const ct = await c.encrypt("s3cr3t");
    expect(ct).not.toContain("s3cr3t");
    expect(await c.decrypt(ct)).toBe("s3cr3t");
    expect(c.keyId()).toMatch(/^appkey:/);
  });

  it("distinct ciphertexts for same plaintext (random IV)", async () => {
    const c = new AppKeySecretCipher(key);
    expect(await c.encrypt("x")).not.toBe(await c.encrypt("x"));
  });

  it("tampered ciphertext fails auth tag", async () => {
    const c = new AppKeySecretCipher(key);
    const ct = await c.encrypt("x");
    // Flip a bit in the decoded ciphertext. Overwriting its text with "00" left it
    // unchanged whenever it already decoded to that byte (1 run in 256).
    const [iv, tag, body] = ct.split(":");
    const bytes = Buffer.from(body, "base64url");
    bytes[0] ^= 0x01;
    await expect(c.decrypt(`${iv}:${tag}:${bytes.toString("base64url")}`)).rejects.toThrow();
  });

  it("rejects a key that isn't 32 bytes of hex", () => {
    expect(() => new AppKeySecretCipher("too-short")).toThrow();
  });
});
