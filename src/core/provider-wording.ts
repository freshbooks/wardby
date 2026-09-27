/**
 * What a host (a PR comment, a check summary) is told when the model provider
 * itself refused a run's requests: the class of problem and who has to act.
 * Public repositories read these, so they never carry the provider's own
 * error code or message; the code stays in the operator log.
 */

export type ProviderFailureClass = "quota" | "rate_limited" | "unavailable" | "rejected";

const CLASSES: readonly ProviderFailureClass[] = ["quota", "rate_limited", "unavailable", "rejected"];

const QUOTA_MARKERS = ["quota", "spend_limit", "billing", "insufficient_funds", "credit"];
const UNAVAILABLE_CODES = new Set([
  "server_error",
  "overloaded",
  "overloaded_error",
  "service_unavailable",
  // Anthropic's name for an internal server error.
  "api_error",
]);

/** Files an upstream error code (or `http_<status>`) under the class of problem it names. */
export function classifyProviderFailure(code: string): ProviderFailureClass {
  const lower = code.toLowerCase();
  // Checked first: an exhausted account is the one case only an operator can fix.
  if (QUOTA_MARKERS.some((marker) => lower.includes(marker))) return "quota";
  if (lower.includes("rate_limit")) return "rate_limited";
  if (UNAVAILABLE_CODES.has(lower) || /^http_5\d\d$/.test(lower)) return "unavailable";
  return "rejected";
}

const SENTENCES: Record<ProviderFailureClass, string> = {
  quota:
    "The model provider refused the request: its account has reached a spending or quota limit. An operator needs to raise the limit with the provider, then retry.",
  rate_limited: "The model provider is rate-limiting requests. Try again later.",
  unavailable: "The model provider reported an outage or overload. Try again later.",
  rejected: "The model provider rejected the request.",
};

export function providerSentence(providerClass: ProviderFailureClass): string {
  return SENTENCES[providerClass];
}

/** The class a run's `provider_<class>` failure category names, or null for any other category. */
export function providerClassOfCategory(category: string | null | undefined): ProviderFailureClass | null {
  if (!category?.startsWith("provider_")) return null;
  const value = category.slice("provider_".length);
  return (CLASSES as readonly string[]).includes(value) ? (value as ProviderFailureClass) : null;
}
