/**
 * Mobile app access (WARDBY_MOBILE_ENABLED, off by default). S1: the app's
 * private-use OAuth redirect (RFC 8252 §7.1); later: push notifications.
 */
export const DEFAULT_MOBILE_REDIRECT_URI = "com.wardby.mobile:/oauth";
export const MOBILE_DISABLED = "mobile_disabled";

/** A reverse-domain scheme (at least one dot), ":/", then a path — no host, query, or fragment. */
const PRIVATE_USE_REDIRECT = /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:\/(?!\/)[A-Za-z0-9/_-]*$/;

export interface MobileConfig {
  enabled: boolean;
  /** The one redirect URI mobile sign-in may use; matched exactly. */
  redirectUri: string;
}

export function loadMobileConfig(env: NodeJS.ProcessEnv = process.env): MobileConfig {
  const raw = env.WARDBY_MOBILE_ENABLED?.trim().toLowerCase() ?? "";
  if (raw !== "" && raw !== "true" && raw !== "false") throw new Error("WARDBY_MOBILE_ENABLED must be true or false.");
  const redirectUri = env.WARDBY_MOBILE_REDIRECT_URI?.trim() || DEFAULT_MOBILE_REDIRECT_URI;
  if (!PRIVATE_USE_REDIRECT.test(redirectUri)) {
    throw new Error("WARDBY_MOBILE_REDIRECT_URI must be a private-use redirect such as com.example.app:/oauth.");
  }
  return { enabled: raw === "true", redirectUri };
}
