import { describe, expect, it } from "vitest";
import type { CiView } from "../providers/review-host/types.js";
import { ciForAgent, ciNote } from "./ci-context.js";

const SHA = "a".repeat(40);
const ci = (over: Partial<CiView>): CiView => ({
  headSha: SHA,
  state: "passing",
  checks: [{ name: "e2e-web", kind: "check_run", status: "completed", conclusion: "success", app: "github-actions" }],
  truncated: false,
  statusesUnavailable: false,
  ...over,
});
const WARNED = "<!-- wardby:r -->\n\n> [!WARNING]\n> **Dependency install incomplete.** Wardby's package registry …";

describe("ciForAgent", () => {
  it("flags the sandbox warning and says CI wins when CI passed", () => {
    const view = ciForAgent({ headSha: SHA, body: WARNED, ci: ci({}) });
    expect(view.sandboxInstallIncomplete).toBe(true);
    expect(view.note).toMatch(/^CI passed on this head \(1 check\)/);
    expect(view.note).toContain("CI is authoritative");
    expect(view.note).toContain("Dependency install incomplete");
  });

  it("names failing checks", () => {
    const failing = ci({
      state: "failing",
      checks: [{ name: "build", kind: "check_run", status: "completed", conclusion: "failure", app: null }],
    });
    expect(ciNote(failing, false)).toMatch(/^CI failed on this head: build\./);
  });

  it("says pending results are not final", () => {
    const pending = ci({
      state: "pending",
      checks: [{ name: "e2e-web", kind: "check_run", status: "in_progress", conclusion: null, app: null }],
    });
    expect(ciNote(pending, false)).toContain("not final");
    expect(ciNote(pending, false)).toContain("e2e-web");
  });

  it("is honest about no CI, unreadable CI, missing statuses, and hosts without CI", () => {
    expect(ciNote(ci({ state: "none", checks: [] }), false)).toMatch(/^No CI checks/);
    expect(ciNote(ci({ state: "unavailable", checks: [], unavailableReason: "host_api_error" }), false)).toContain(
      "could not be read (host_api_error)",
    );
    expect(ciNote(ci({ statusesUnavailable: true }), false)).toContain("commit statuses could not be read");
    expect(ciForAgent({ headSha: SHA, body: "", ci: undefined })).toMatchObject({
      state: "unavailable",
      unavailableReason: "host_unsupported",
      sandboxInstallIncomplete: false,
    });
  });
});
