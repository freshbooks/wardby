/**
 * The notification dispatcher against real PostgreSQL with a fake Slack:
 * the thread lifecycle (one parent, replies, status edits, broadcast),
 * in-thread ordering under failure, rate limits, unreachable channels, the
 * auth pause, the lease, the attempt cap, and pruning. Skipped without
 * DATABASE_URL.
 *
 * Other database suites may leave pending Slack deliveries behind while they
 * run in parallel; the scoped fake rate-limits any channel that is not this
 * suite's, so those rows are never posted and never consume a queued failure.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeChatProvider } from "../providers/chat/fake.js";
import { ChatError, type ChatMessage } from "../providers/chat/types.js";
import { createPrismaClient } from "./db.js";
import {
  DISPATCH_LEASE_SCOPE,
  dispatchOnce,
  pruneWorkflowEvents,
  type DispatcherDeps,
} from "./notification-dispatcher.js";
import { createWorkflowEventRecorder } from "./workflow-event-recorder.js";
import type { WorkflowPayload } from "./workflow-events.js";

class ScopedFake extends FakeChatProvider {
  constructor(private readonly prefix: string) {
    super();
  }
  private guard(channelId: string): void {
    if (!channelId.startsWith(this.prefix)) throw new ChatError("rate_limited", "foreign_test_channel", 3_600_000);
  }
  /** Runs before each in-scope threaded reply. */
  beforeReply: (() => Promise<void>) | null = null;
  override async postMessage(
    channelId: string,
    msg: ChatMessage,
    opts?: { threadTs?: string; broadcast?: boolean },
  ): Promise<{ ts: string }> {
    this.guard(channelId);
    const hook = opts?.threadTs ? this.beforeReply : null;
    if (hook) {
      this.beforeReply = null;
      await hook();
    }
    return super.postMessage(channelId, msg, opts);
  }
  /** Runs before each in-scope chat.update (after the delivery it follows is marked delivered). */
  beforeUpdate: (() => Promise<void>) | null = null;
  override async updateMessage(channelId: string, ts: string, msg: ChatMessage): Promise<void> {
    this.guard(channelId);
    const hook = this.beforeUpdate;
    this.beforeUpdate = null;
    if (hook) await hook();
    return super.updateMessage(channelId, ts, msg);
  }
}

describe.skipIf(!process.env.DATABASE_URL)("notification dispatcher (database)", () => {
  const db = createPrismaClient();
  const recorder = createWorkflowEventRecorder(db, ["slack"]);
  const s = randomUUID();
  const tag = s.replace(/-/g, "").slice(0, 10).toUpperCase();
  const prefix = `CDSP${tag}`;
  const owner = `wfdsp-owner-${s}`;
  const projects: string[] = [];
  let counter = 0;
  let fake: ScopedFake;
  let clock: Date;
  let deps: DispatcherDeps;

  const at = (offsetMs: number) => new Date(clock.getTime() + offsetMs);
  const makeDeps = (holder = "dsp-holder-a"): DispatcherDeps => ({
    db,
    chat: { slack: fake },
    holder: `${holder}-${s}`,
    now: () => clock,
    sleep: async () => {},
  });

  /** A fresh project + work item + channel link; returns the channel and item key. */
  async function seedThread(): Promise<{ channelId: string; itemKey: string }> {
    const n = ++counter;
    const projectKey = `DSP${tag}${n}`;
    projects.push(projectKey);
    const itemKey = `${projectKey}-1`;
    const channelId = `${prefix}N${n}`;
    await db.workItem.create({
      data: {
        provider: "jira",
        key: itemKey,
        scopeKey: projectKey,
        title: "Checkout",
        url: "https://acme.example/PAY",
      },
    });
    await db.notificationChannel.create({
      data: { provider: "slack", channelId, issueProvider: "jira", projectKey, authorizedById: owner },
    });
    return { channelId, itemKey };
  }

  async function record(itemKey: string, payload: WorkflowPayload, name: string): Promise<void> {
    await recorder({ dedupeKey: `${name}:${itemKey}-${s}`, payload, workItem: { provider: "jira", key: itemKey } });
  }

  const deliveriesFor = (channelId: string) =>
    db.notificationDelivery.findMany({ where: { channelId }, orderBy: { createdAt: "asc" } });

  const picked: WorkflowPayload = { kind: "issue_picked_up", agentName: "builder", trigger: "assigned" };
  const opened: WorkflowPayload = {
    kind: "pr_opened",
    prLabel: "acme/x#7",
    prUrl: "https://github.com/acme/x/pull/7",
    movedTo: null,
  };
  const merged: WorkflowPayload = {
    kind: "pr_closed",
    prLabel: "acme/x#7",
    prUrl: "https://github.com/acme/x/pull/7",
    merged: true,
    movedTo: "Done",
  };

  async function drain(d: DispatcherDeps): Promise<void> {
    for (let i = 0; i < 20; i++) if ((await dispatchOnce(d)) === 0) return;
  }

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
  });

  beforeEach(async () => {
    await db.schedulerLease.deleteMany({ where: { scope: DISPATCH_LEASE_SCOPE } });
    fake = new ScopedFake(prefix);
    clock = new Date(Date.now() + 5_000);
    deps = makeDeps();
  });

  afterEach(async () => {
    await db.workflowEvent.deleteMany({ where: { dedupeKey: { endsWith: `-${s}` } } });
    await db.notificationThread.deleteMany({ where: { channelId: { startsWith: prefix } } });
    await db.schedulerLease.deleteMany({ where: { scope: DISPATCH_LEASE_SCOPE } });
  });

  afterAll(async () => {
    await db.notificationChannel.deleteMany({ where: { channelId: { startsWith: prefix } } });
    await db.workItem.deleteMany({ where: { provider: "jira", scopeKey: { in: projects } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("posts one parent, threads every reply under it, edits the status line, and broadcasts the merge", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    await record(itemKey, opened, "opened");
    await record(itemKey, merged, "merged");

    await drain(deps);

    const posts = fake.posts.filter((p) => p.channelId === channelId);
    expect(posts).toHaveLength(4);
    const [parent, ...replies] = posts;
    expect(parent.threadTs).toBeUndefined();
    expect(parent.msg.text).toContain(itemKey);
    expect(parent.msg.text).toContain("Checkout");
    expect(parent.msg.text).toContain("picked up");
    for (const r of replies) expect(r.threadTs).toBe(parent.ts);
    expect(replies.map((r) => r.broadcast)).toEqual([false, false, true]);

    const updates = fake.updates.filter((u) => u.channelId === channelId);
    expect(updates.every((u) => u.ts === parent.ts)).toBe(true);
    expect(updates.at(-1)?.msg.text).toContain("merged ✅");

    const rows = await deliveriesFor(channelId);
    expect(rows.map((r) => r.state)).toEqual(["delivered", "delivered", "delivered"]);
    expect(rows.map((r) => r.messageTs)).toEqual(replies.map((r) => r.ts));
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    const thread = await db.notificationThread.findFirstOrThrow({ where: { channelId } });
    expect(thread.parentTs).toBe(parent.ts);
    expect(thread.status).toBe("merged ✅");
  });

  it("never lets a younger delivery overtake an older one that failed", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    await record(itemKey, opened, "opened");
    fake.failNext("postMessage", new ChatError("transient", "internal_error"));

    expect(await dispatchOnce(deps)).toBeGreaterThanOrEqual(1);
    expect(fake.posts.filter((p) => p.channelId === channelId)).toHaveLength(0);
    const [first, second] = await deliveriesFor(channelId);
    expect(first).toMatchObject({ state: "pending", attempts: 1, lastError: "internal_error" });
    expect(first.nextAttemptAt.getTime()).toBe(at(5000).getTime());
    expect(second).toMatchObject({ state: "pending", attempts: 0 });

    // Still backing off: the younger delivery is due but must wait.
    await dispatchOnce(deps);
    expect(fake.posts.filter((p) => p.channelId === channelId)).toHaveLength(0);

    clock = at(6000);
    await drain(deps);
    const posts = fake.posts.filter((p) => p.channelId === channelId);
    expect(posts).toHaveLength(3);
    expect(posts[0].threadTs).toBeUndefined();
    expect(posts.slice(1).map((p) => p.threadTs)).toEqual([posts[0].ts, posts[0].ts]);
    const rows = await deliveriesFor(channelId);
    expect(rows.map((r) => r.state)).toEqual(["delivered", "delivered"]);
    expect(rows[0].messageTs).toBe(posts[1].ts);
    expect(rows[1].messageTs).toBe(posts[2].ts);
  });

  it("defers a rate-limited delivery without counting an attempt", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    fake.failNext("postMessage", new ChatError("rate_limited", "ratelimited", 7000));

    await dispatchOnce(deps);

    const [row] = await deliveriesFor(channelId);
    expect(row).toMatchObject({ state: "pending", attempts: 0 });
    expect(row.nextAttemptAt.getTime()).toBe(at(7000).getTime());
  });

  it("fails every pending delivery for an unreachable channel and stamps the link", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    await record(itemKey, opened, "opened");
    fake.failNext("postMessage", new ChatError("channel_unreachable", "not_in_channel"));

    await dispatchOnce(deps);

    const rows = await deliveriesFor(channelId);
    expect(rows.map((r) => r.state)).toEqual(["failed", "failed"]);
    expect(rows.every((r) => r.lastError === "not_in_channel")).toBe(true);
    const link = await db.notificationChannel.findFirstOrThrow({ where: { channelId } });
    expect(link.lastError).toBe("not_in_channel");
    expect(link.lastErrorAt?.getTime()).toBe(clock.getTime());
  });

  it("pauses on auth failure and resumes after a successful auth.test", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    fake.failNext("postMessage", new ChatError("auth_failed", "token_revoked"));

    await dispatchOnce(deps);
    clock = at(60_000);
    expect(await dispatchOnce(deps)).toBe(0);
    const [row] = await deliveriesFor(channelId);
    expect(row).toMatchObject({ state: "pending", attempts: 0 });
    expect(deps.state?.pausedUntil).toBeInstanceOf(Date);

    // Still revoked at the 5-minute re-check: the pause is extended.
    clock = at(5 * 60_000);
    fake.failNext("authTest", new ChatError("auth_failed", "token_revoked"));
    expect(await dispatchOnce(deps)).toBe(0);
    expect(fake.posts.filter((p) => p.channelId === channelId)).toHaveLength(0);

    clock = at(5 * 60_000 + 1000);
    await drain(deps);
    expect(deps.state?.pausedUntil).toBeUndefined();
    expect((await deliveriesFor(channelId))[0].state).toBe("delivered");
  });

  it("delivers each row exactly once when two dispatchers race for the lease", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    await record(itemKey, opened, "opened");
    const other = makeDeps("dsp-holder-b");

    const counts = await Promise.all([dispatchOnce(deps), dispatchOnce(other)]);
    expect(counts.filter((c) => c === 0).length).toBeGreaterThanOrEqual(1);
    await Promise.all([drain(deps), drain(other)]);

    const posts = fake.posts.filter((p) => p.channelId === channelId);
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((p) => p.msg.text)).size).toBe(3);
  });

  it("stops a pass whose lease expired mid-pass so a second holder never double-posts", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    await record(itemKey, opened, "opened");
    await record(itemKey, merged, "merged");
    const other = makeDeps("dsp-holder-b");
    // After "opened" is delivered (its status edit is next), A's lease lapses and B runs a full pass.
    fake.beforeUpdate = async () => {
      await db.schedulerLease.updateMany({ where: { scope: DISPATCH_LEASE_SCOPE }, data: { expiresAt: new Date(0) } });
      expect(await dispatchOnce(other)).toBe(1);
    };

    expect(await dispatchOnce(deps)).toBe(2);
    await drain(other);

    const posts = fake.posts.filter((p) => p.channelId === channelId);
    expect(posts).toHaveLength(4);
    expect(new Set(posts.map((p) => p.msg.text)).size).toBe(4);
    const rows = await deliveriesFor(channelId);
    expect(rows.map((r) => r.state)).toEqual(["delivered", "delivered", "delivered"]);
    // A's in-flight "PR open" edit must not win over B's terminal status.
    const thread = await db.notificationThread.findFirstOrThrow({ where: { channelId } });
    expect(thread.status).toBe("merged ✅");
    expect(fake.updates.filter((u) => u.channelId === channelId).at(-1)?.msg.text).toContain("merged ✅");
  });

  it("renders the derived status even when the stored status is stale", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    await record(itemKey, opened, "opened");
    await drain(deps);
    await record(itemKey, merged, "merged");
    fake.beforeReply = async () => {
      await db.notificationThread.updateMany({ where: { channelId }, data: { status: "picked up" } });
    };

    await drain(deps);

    expect(fake.updates.filter((u) => u.channelId === channelId).at(-1)?.msg.text).toContain("merged ✅");
    expect((await db.notificationThread.findFirstOrThrow({ where: { channelId } })).status).toBe("merged ✅");
  });

  it("leaves the status alone after a failed edit and catches up on the next delivery", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    await drain(deps);
    await record(itemKey, opened, "opened");
    fake.failNext("updateMessage", new ChatError("transient", "internal_error"));

    await drain(deps);
    expect((await db.notificationThread.findFirstOrThrow({ where: { channelId } })).status).toBe("picked up");
    expect((await deliveriesFor(channelId)).map((r) => r.state)).toEqual(["delivered", "delivered"]);

    // A COMMENT review does not change the status by itself; the derived "PR open" still lands.
    const comment: WorkflowPayload = {
      kind: "review_posted",
      agentName: "reviewer",
      verdict: "COMMENT",
      prLabel: "acme/x#7",
      prUrl: null,
      ciPending: false,
    };
    await record(itemKey, comment, "comment");
    await drain(deps);
    const updates = fake.updates.filter((u) => u.channelId === channelId);
    expect(updates).toHaveLength(1);
    expect(updates[0].msg.text).toContain("PR open");
    expect((await db.notificationThread.findFirstOrThrow({ where: { channelId } })).status).toBe("PR open");
  });

  it("stops starting deliveries once a pass has run for 20 s", async () => {
    const a = await seedThread();
    const b = await seedThread();
    await record(a.itemKey, picked, "picked");
    await record(b.itemKey, picked, "picked");
    const start = clock;
    let calls = 0;
    deps.now = () => (++calls === 1 ? start : new Date(start.getTime() + 21_000));

    expect(await dispatchOnce(deps)).toBe(1);
    const states = [...(await deliveriesFor(a.channelId)), ...(await deliveriesFor(b.channelId))].map((r) => r.state);
    expect(states).toEqual(["delivered", "pending"]);
  });

  it("fails a delivery at the attempt cap", async () => {
    const { channelId, itemKey } = await seedThread();
    await record(itemKey, picked, "picked");
    await db.notificationDelivery.updateMany({ where: { channelId }, data: { attempts: 9 } });
    fake.failNext("postMessage", new ChatError("transient", "fetch_failed"));

    await dispatchOnce(deps);

    const [row] = await deliveriesFor(channelId);
    expect(row).toMatchObject({ state: "failed", attempts: 10, lastError: "fetch_failed" });
  });

  it("prunes old settled events and keeps any with a pending delivery", async () => {
    const old = new Date(clock.getTime() - 31 * 86_400_000);
    const mk = (name: string, state: string) =>
      db.workflowEvent.create({
        data: {
          kind: "issue_picked_up",
          dedupeKey: `prune-${name}-${s}`,
          payload: picked,
          createdAt: old,
          deliveries: { create: { provider: "slack", channelId: `${prefix}P`, threadKey: `run:${name}`, state } },
        },
      });
    const done = await mk("done", "delivered");
    const waiting = await mk("waiting", "pending");
    const fresh = await db.workflowEvent.create({
      data: { kind: "issue_picked_up", dedupeKey: `prune-fresh-${s}`, payload: picked, createdAt: clock },
    });
    // Keep the pending row out of reach of a racing dispatcher pass.
    await db.notificationDelivery.updateMany({
      where: { eventId: waiting.id },
      data: { nextAttemptAt: at(86_400_000) },
    });

    expect(await pruneWorkflowEvents(db, clock)).toBeGreaterThanOrEqual(1);

    expect(await db.workflowEvent.findUnique({ where: { id: done.id } })).toBeNull();
    expect(await db.notificationDelivery.count({ where: { eventId: done.id } })).toBe(0);
    expect(await db.workflowEvent.findUnique({ where: { id: waiting.id } })).not.toBeNull();
    expect(await db.workflowEvent.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });
});
