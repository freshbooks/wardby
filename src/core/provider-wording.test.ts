import { describe, expect, it } from "vitest";
import { classifyProviderFailure, providerClassOfCategory, providerSentence } from "./provider-wording.js";

describe("classifyProviderFailure", () => {
  it.each([
    ["project_spend_limit_exceeded", "quota"],
    ["insufficient_quota", "quota"],
    ["billing_hard_limit_reached", "quota"],
    ["insufficient_funds", "quota"],
    ["credit_balance_too_low", "quota"],
    ["rate_limit_exceeded", "rate_limited"],
    ["rate_limit_error", "rate_limited"],
    ["server_error", "unavailable"],
    ["overloaded", "unavailable"],
    ["overloaded_error", "unavailable"],
    ["service_unavailable", "unavailable"],
    ["http_500", "unavailable"],
    ["http_503", "unavailable"],
    ["http_429", "rejected"],
    ["invalid_request_error", "rejected"],
    ["unknown", "rejected"],
  ])("%s -> %s", (code, expected) => {
    expect(classifyProviderFailure(code)).toBe(expected);
  });

  it("files a quota code as quota even when it also mentions a rate limit", () => {
    expect(classifyProviderFailure("rate_limit_quota_exceeded")).toBe("quota");
  });
});

describe("providerSentence", () => {
  it("says who has to act for each class", () => {
    expect(providerSentence("quota")).toBe(
      "The model provider refused the request: its account has reached a spending or quota limit. An operator needs to raise the limit with the provider, then retry.",
    );
    expect(providerSentence("rate_limited")).toBe("The model provider is rate-limiting requests. Try again later.");
    expect(providerSentence("unavailable")).toBe("The model provider reported an outage or overload. Try again later.");
    expect(providerSentence("rejected")).toBe("The model provider rejected the request.");
  });
});

describe("providerClassOfCategory", () => {
  it("reads the class back out of a run's failure category", () => {
    expect(providerClassOfCategory("provider_quota")).toBe("quota");
    expect(providerClassOfCategory("provider_rate_limited")).toBe("rate_limited");
    expect(providerClassOfCategory("provider_bogus")).toBeNull();
    expect(providerClassOfCategory("budget")).toBeNull();
    expect(providerClassOfCategory(null)).toBeNull();
  });
});
