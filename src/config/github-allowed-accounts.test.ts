import { describe, expect, it } from "vitest";
import {
  GITHUB_ACCOUNT_NOT_ALLOWED,
  githubAccountOf,
  isGitHubAccountAllowed,
  isGitHubLogin,
  loadGitHubAllowedAccounts,
  parseGitHubAllowedAccounts,
  trustedAccounts,
} from "./github-allowed-accounts.js";

describe("parseGitHubAllowedAccounts", () => {
  it("is empty when unset, empty, or whitespace", () => {
    expect(parseGitHubAllowedAccounts(undefined).size).toBe(0);
    expect(parseGitHubAllowedAccounts("").size).toBe(0);
    expect(parseGitHubAllowedAccounts("  , ,\n").size).toBe(0);
  });

  it("lower-cases, trims, and de-duplicates logins", () => {
    expect([...parseGitHubAllowedAccounts(" Acme , acme-labs,ACME ")].sort()).toEqual(["acme", "acme-labs"]);
  });

  it("rejects anything that is not a GitHub login, including a wildcard", () => {
    for (const bad of ["*", "-acme", "acme/repo", "a".repeat(40), "acme labs", "acme_labs"]) {
      expect(() => parseGitHubAllowedAccounts(bad)).toThrow(
        `WARDBY_GITHUB_ALLOWED_ACCOUNTS: "${bad}" is not a GitHub login.`,
      );
    }
  });

  it("loads from the environment", () => {
    expect([...loadGitHubAllowedAccounts({ WARDBY_GITHUB_ALLOWED_ACCOUNTS: "acme" })]).toEqual(["acme"]);
    expect(loadGitHubAllowedAccounts({}).size).toBe(0);
  });
});

describe("trustedAccounts / isGitHubAccountAllowed", () => {
  it("always includes the owner, and only adds the listed accounts", () => {
    const trusted = trustedAccounts("Owner-Org", parseGitHubAllowedAccounts("acme"));
    expect(isGitHubAccountAllowed(trusted, "owner-org")).toBe(true);
    expect(isGitHubAccountAllowed(trusted, "ACME")).toBe(true);
    expect(isGitHubAccountAllowed(trusted, "stranger")).toBe(false);
  });

  it("serves the owner only when nothing is listed", () => {
    const trusted = trustedAccounts("owner-org", parseGitHubAllowedAccounts(undefined));
    expect([...trusted]).toEqual(["owner-org"]);
  });
});

describe("helpers", () => {
  it("returns the lower-cased owner of owner/name", () => {
    expect(githubAccountOf("Acme/Widgets")).toBe("acme");
  });

  it("validates a login", () => {
    expect(isGitHubLogin("acme-labs")).toBe(true);
    expect(isGitHubLogin("*")).toBe(false);
    expect(isGitHubLogin(42)).toBe(false);
  });

  it("exports the error code", () => {
    expect(GITHUB_ACCOUNT_NOT_ALLOWED).toBe("github_account_not_allowed");
  });
});
