import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { spanHash } from "./span-hash.js";

const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

describe("spanHash", () => {
  const file = "one\ntwo\nthree\n";
  it("hashes the cited lines, each followed by a newline (sed -n 'A,Bp' | sha256sum)", () => {
    expect(spanHash(file, [2, 3])).toBe(sha("two\nthree\n"));
  });
  it("hashes the whole file without lines", () => {
    expect(spanHash(file)).toBe(sha(file));
  });
  it("returns null when the range is outside the file", () => {
    expect(spanHash(file, [3, 9])).toBeNull();
    expect(spanHash(file, [0, 1])).toBeNull();
  });
  it("treats a missing final newline like sed does", () => {
    expect(spanHash("a\nb", [2, 2])).toBe(sha("b\n"));
  });
});
