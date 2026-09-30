import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "#prisma";

vi.mock("../../core/issue-events.js", () => ({
  routeIssueEvent: vi.fn(async () => ({ runIds: ["run1"], followUps: [vi.fn(async () => undefined)] })),
}));
vi.mock("../../providers/issue-tracker/jira-events.js", async (orig) => ({
  ...(await orig<typeof import("../../providers/issue-tracker/jira-events.js")>()),
  normalizeJiraEvent: vi.fn(() => ({ kind: "created" })),
}));
import { routeIssueEvent } from "../../core/issue-events.js";
import { normalizeJiraEvent } from "../../providers/issue-tracker/jira-events.js";
import { resetPruneClockForTests } from "./deliveries.js";
import { handleJiraEventIngress } from "./jira-ingress.js";

const SECRET = "jira-webhook-secret-0123456789";
const NOW = 1_780_000_000_000;
const bodyAt = (timestamp?: unknown) =>
  JSON.stringify({ webhookEvent: "jira:issue_created", issue: { key: "ABC-1" }, timestamp });
const body = bodyAt(NOW - 1000);
const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

function deps(overrides: Record<string, unknown> = {}) {
  const created: string[] = [];
  const hostEventDelivery = {
    create: vi.fn(async ({ data }: { data: { deliveryId: string } }) => {
      if (created.includes(data.deliveryId)) {
        throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
      }
      created.push(data.deliveryId);
    }),
    deleteMany: vi.fn(async ({ where }: { where: { deliveryId?: string } }) => {
      const idx = created.indexOf(where.deliveryId ?? "");
      if (idx === -1) return { count: 0 };
      created.splice(idx, 1);
      return { count: 1 };
    }),
  };
  return {
    created,
    hostEventDelivery,
    deps: {
      db: { hostEventDelivery } as never,
      executor: {} as never,
      trackers: {
        jira: { botAccountId: async () => "bot-1", identity: async () => ({ accountId: "bot-1", accountType: "app" }) },
      } as never,
      webhookSecret: SECRET,
      now: () => NOW,
      ...overrides,
    },
  };
}

const headers = (h: Record<string, string | undefined> = {}) => ({
  "x-hub-signature": sign(body),
  "x-atlassian-webhook-identifier": "id-1",
  ...h,
});

describe("handleJiraEventIngress", () => {
  beforeEach(() => {
    vi.mocked(routeIssueEvent).mockClear();
    vi.mocked(normalizeJiraEvent).mockClear();
    vi.mocked(normalizeJiraEvent).mockReturnValue({ kind: "created" } as never);
  });

  it("routes a signed new delivery and returns run ids", async () => {
    const { deps: d, hostEventDelivery } = deps();
    const result = await handleJiraEventIngress({ headers: headers(), rawBody: body }, d);
    expect(result).toMatchObject({ status: 202, body: { runIds: ["run1"] } });
    expect(hostEventDelivery.create).toHaveBeenCalledWith({ data: { provider: "jira", deliveryId: "id-1" } });
    expect(normalizeJiraEvent).toHaveBeenCalledWith(JSON.parse(body), "bot-1");
    expect(routeIssueEvent).toHaveBeenCalledWith(
      { kind: "created" },
      { db: d.db, executor: d.executor, trackers: d.trackers },
    );
    await result.afterResponse?.();
  });

  it("answers 503 for a personal-account token without recording or routing", async () => {
    const { deps: d, hostEventDelivery } = deps();
    (d.trackers as { jira: { identity: unknown } }).jira.identity = async () => ({
      accountId: "u-1",
      accountType: "atlassian",
    });
    const result = await handleJiraEventIngress({ headers: headers(), rawBody: body }, d);
    expect(result).toMatchObject({ status: 503, body: { error: "jira_personal_account" } });
    expect(hostEventDelivery.create).not.toHaveBeenCalled();
    expect(routeIssueEvent).not.toHaveBeenCalled();
  });

  it("propagates an identity lookup failure so Jira retries", async () => {
    const { deps: d, hostEventDelivery } = deps();
    (d.trackers as { jira: { identity: unknown } }).jira.identity = async () => {
      throw new Error("network");
    };
    await expect(handleJiraEventIngress({ headers: headers(), rawBody: body }, d)).rejects.toThrow("network");
    expect(hostEventDelivery.create).not.toHaveBeenCalled();
  });

  it("prunes old delivery rows on a Jira delivery", async () => {
    resetPruneClockForTests();
    const { deps: d, hostEventDelivery } = deps();
    await handleJiraEventIngress({ headers: headers(), rawBody: body }, d);
    expect(hostEventDelivery.deleteMany).toHaveBeenCalledWith({
      where: { receivedAt: { lt: expect.any(Date) } },
    });
  });

  it("rejects a bad signature without writing or routing", async () => {
    const { deps: d, hostEventDelivery } = deps();
    const result = await handleJiraEventIngress(
      { headers: headers({ "x-hub-signature": "sha256=00" }), rawBody: body },
      d,
    );
    expect(result).toMatchObject({ status: 401, body: { error: "invalid_signature" } });
    expect(hostEventDelivery.create).not.toHaveBeenCalled();
    expect(routeIssueEvent).not.toHaveBeenCalled();
  });

  it("rejects a missing or malformed delivery identifier", async () => {
    const { deps: d } = deps();
    for (const id of [undefined, "bad id!"]) {
      const result = await handleJiraEventIngress(
        { headers: headers({ "x-atlassian-webhook-identifier": id }), rawBody: body },
        d,
      );
      expect(result).toMatchObject({ status: 400, body: { error: "missing_delivery_headers" } });
    }
  });

  it("rejects invalid JSON", async () => {
    const { deps: d } = deps();
    const raw = "{not json";
    const result = await handleJiraEventIngress(
      { headers: headers({ "x-hub-signature": sign(raw) }), rawBody: raw },
      d,
    );
    expect(result).toMatchObject({ status: 400, body: { error: "invalid_json" } });
  });

  it("ignores an unrecognised event without recording the delivery", async () => {
    vi.mocked(normalizeJiraEvent).mockReturnValue(null);
    const { deps: d, hostEventDelivery } = deps();
    const result = await handleJiraEventIngress({ headers: headers(), rawBody: body }, d);
    expect(result).toMatchObject({ status: 202, body: { ignored: true } });
    expect(hostEventDelivery.create).not.toHaveBeenCalled();
    expect(routeIssueEvent).not.toHaveBeenCalled();
  });

  it("treats a duplicate delivery as done without routing", async () => {
    const { deps: d } = deps();
    await handleJiraEventIngress({ headers: headers(), rawBody: body }, d);
    vi.mocked(routeIssueEvent).mockClear();
    const second = await handleJiraEventIngress({ headers: headers(), rawBody: body }, d);
    expect(second).toMatchObject({ status: 202, body: { duplicate: true } });
    expect(routeIssueEvent).not.toHaveBeenCalled();
  });

  it("un-records the delivery and rethrows when routing fails", async () => {
    vi.mocked(routeIssueEvent).mockRejectedValueOnce(new Error("boom"));
    const { deps: d, created } = deps();
    await expect(handleJiraEventIngress({ headers: headers(), rawBody: body }, d)).rejects.toThrow("boom");
    expect(created).toEqual([]);
  });

  describe("replay window", () => {
    const HOUR = 60 * 60 * 1000;
    const cases: Array<[string, unknown, boolean]> = [
      ["fresh (ms)", NOW - 1000, true],
      ["just inside 2 h", NOW - 2 * HOUR + 1000, true],
      ["a few minutes ahead", NOW + 4 * 60 * 1000, true],
      ["fresh, in seconds", Math.floor((NOW - 1000) / 1000), true],
      ["older than 2 h", NOW - 2 * HOUR - 1000, false],
      ["stale, in seconds", Math.floor((NOW - 3 * HOUR) / 1000), false],
      ["more than 5 min ahead", NOW + 6 * 60 * 1000, false],
      ["missing", undefined, false],
      ["a string", String(NOW), false],
      ["null", null, false],
    ];
    it.each(cases)("%s", async (_name, ts, accepted) => {
      const { deps: d, hostEventDelivery } = deps();
      const raw = bodyAt(ts);
      const result = await handleJiraEventIngress(
        { headers: headers({ "x-hub-signature": sign(raw) }), rawBody: raw },
        d,
      );
      if (accepted) {
        expect(result).toMatchObject({ status: 202, body: { runIds: ["run1"] } });
      } else {
        expect(result).toMatchObject({ status: 202, body: { ignored: "stale" } });
        expect(hostEventDelivery.create).not.toHaveBeenCalled();
        expect(routeIssueEvent).not.toHaveBeenCalled();
      }
    });
  });

  it("is disabled without a Jira tracker", async () => {
    const { deps: d } = deps({ trackers: {} });
    expect((await handleJiraEventIngress({ headers: headers(), rawBody: body }, d)).status).toBe(404);
  });
});
