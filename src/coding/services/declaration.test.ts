import { describe, expect, it } from "vitest";
import { MAX_SERVICE_DECLARATION_BYTES, ServiceDeclarationError, parseServiceDeclaration } from "./declaration.js";

function reasonOf(text: string): string {
  try {
    parseServiceDeclaration(text);
  } catch (error) {
    if (error instanceof ServiceDeclarationError) return error.reason;
    throw error;
  }
  throw new Error("expected the declaration to be refused");
}

describe("parseServiceDeclaration", () => {
  it("reads the documented example, comments included", () => {
    const text = [
      "# Services wardby starts next to coding runs for this repository.",
      "services:",
      '  postgres: "16"',
      '  redis: "7"   # a cache for the session tests',
      "",
    ].join("\n");
    expect(parseServiceDeclaration(text)).toEqual([
      { name: "postgres", version: "16" },
      { name: "redis", version: "7" },
    ]);
  });

  it("accepts bare and single-quoted versions and keeps every version a string", () => {
    expect(parseServiceDeclaration("services:\n    mysql: 8.0\n    postgres: '16'\n")).toEqual([
      { name: "mysql", version: "8.0" },
      { name: "postgres", version: "16" },
    ]);
  });

  it("tolerates CRLF line endings and a byte-order mark", () => {
    expect(parseServiceDeclaration('﻿services:\r\n  postgres: "16"\r\n')).toEqual([
      { name: "postgres", version: "16" },
    ]);
  });

  it("reads an empty list as no services", () => {
    expect(parseServiceDeclaration("services:\n")).toEqual([]);
    expect(parseServiceDeclaration("services: {}\n")).toEqual([]);
  });

  it.each([
    ["no services key", "# nothing here\n", "it has no `services:` key"],
    [
      "another top-level key",
      'services:\n  postgres: "16"\nimage: evil\n',
      "line 3: the only top-level key allowed is `services`",
    ],
    ["a second services key", "services:\nservices:\n", "line 2: the only top-level key allowed is `services`"],
    ["a document marker", '---\nservices:\n  postgres: "16"\n', "line 1: the only top-level key allowed is `services`"],
    ["a flow mapping", 'services: {postgres: "16"}\n', "line 1: the only top-level key allowed is `services`"],
    ["an entry before services", '  postgres: "16"\nservices:\n', "line 1: entries must sit under `services:`"],
    ["tabs", 'services:\n\tpostgres: "16"\n', "line 2: use spaces, not tabs"],
    [
      "a nested value",
      "services:\n  postgres:\n    version: 16\n",
      'line 2: expected `name: version`, like `postgres: "16"`',
    ],
    [
      "uneven indentation",
      'services:\n  postgres: "16"\n    redis: "7"\n',
      "line 3: every service must use the same indentation",
    ],
    [
      "an upper-case name",
      'services:\n  Postgres: "16"\n',
      "line 2: a service name must be lowercase letters, digits and hyphens, starting with a letter",
    ],
    [
      "an anchor",
      'services:\n  postgres: &pg "16"\n',
      'line 2: the version for `postgres` must be a short string like "16"',
    ],
    [
      "a tag",
      "services:\n  postgres: !!str 16\n",
      'line 2: the version for `postgres` must be a short string like "16"',
    ],
    [
      "a list value",
      "services:\n  postgres: [16]\n",
      'line 2: the version for `postgres` must be a short string like "16"',
    ],
    ["a duplicate", 'services:\n  postgres: "16"\n  postgres: "15"\n', "line 3: `postgres` is listed twice"],
    [
      "six services",
      `services:\n${["a", "b", "c", "d", "e", "f"].map((n) => `  ${n}: "1"`).join("\n")}\n`,
      "it lists more than 5 services",
    ],
    ["a control character", 'services:\n  postgres: "16"\u0007\n', "line 2: control characters are not allowed"],
  ])("refuses %s", (_label, text, reason) => {
    expect(reasonOf(text)).toBe(reason);
  });

  it("refuses a file over the size cap", () => {
    const text = `services:\n${"#".repeat(MAX_SERVICE_DECLARATION_BYTES)}\n`;
    expect(reasonOf(text)).toBe(`it is larger than ${MAX_SERVICE_DECLARATION_BYTES} bytes`);
  });

  it("never echoes a name that failed validation", () => {
    const reason = reasonOf('services:\n  "<img src=x>": "16"\n');
    expect(reason).not.toContain("<img");
  });

  it("carries the reason in the error message for the operator log", () => {
    expect(() => parseServiceDeclaration("image: x\n")).toThrow("service_declaration_invalid: line 1:");
  });
});
