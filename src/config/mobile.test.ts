import { describe, expect, it } from "vitest";
import { DEFAULT_MOBILE_REDIRECT_URI, MOBILE_DISABLED, loadMobileConfig } from "./mobile.js";

describe("loadMobileConfig", () => {
  it("is disabled by default, with the default redirect", () => {
    expect(loadMobileConfig({})).toEqual({ enabled: false, redirectUri: "com.wardby.mobile:/oauth" });
    expect(loadMobileConfig({ WARDBY_MOBILE_ENABLED: "  " })).toEqual({
      enabled: false,
      redirectUri: DEFAULT_MOBILE_REDIRECT_URI,
    });
  });

  it("reads true/false case-insensitively and rejects anything else", () => {
    expect(loadMobileConfig({ WARDBY_MOBILE_ENABLED: " TRUE " }).enabled).toBe(true);
    expect(loadMobileConfig({ WARDBY_MOBILE_ENABLED: "false" }).enabled).toBe(false);
    for (const bad of ["1", "yes", "on", "wardby_mobile_enabled"]) {
      expect(() => loadMobileConfig({ WARDBY_MOBILE_ENABLED: bad })).toThrow(
        "WARDBY_MOBILE_ENABLED must be true or false.",
      );
    }
  });

  it("accepts a private-use redirect override", () => {
    expect(
      loadMobileConfig({ WARDBY_MOBILE_ENABLED: "true", WARDBY_MOBILE_REDIRECT_URI: "com.example.app:/oauth" })
        .redirectUri,
    ).toBe("com.example.app:/oauth");
  });

  it("rejects redirects that are not reverse-domain private-use URIs", () => {
    for (const bad of [
      "https://app.example/cb",
      "http://127.0.0.1/cb",
      "myapp:/oauth",
      "com.example.app://host/oauth",
      "com.example.app:/oauth?x=1",
      "com.example.app:/oauth#f",
      "javascript:/x",
    ]) {
      expect(() => loadMobileConfig({ WARDBY_MOBILE_REDIRECT_URI: bad })).toThrow(
        "WARDBY_MOBILE_REDIRECT_URI must be a private-use redirect such as com.example.app:/oauth.",
      );
    }
  });

  it("exports the error code", () => {
    expect(MOBILE_DISABLED).toBe("mobile_disabled");
  });
});
