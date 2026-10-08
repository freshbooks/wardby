import { describe, expect, it } from "vitest";
import { FakeChatProvider } from "./fake.js";
import { ChatError } from "./types.js";

describe("FakeChatProvider", () => {
  it("records posts with incrementing ts and resolves channelInfo/authTest", async () => {
    const chat = new FakeChatProvider();
    expect(await chat.postMessage("C1", { text: "one" })).toEqual({ ts: "1.000" });
    expect(await chat.postMessage("C1", { text: "two" }, { threadTs: "1.000", broadcast: true })).toEqual({ ts: "2.000" });
    expect(chat.posts).toEqual([
      { channelId: "C1", ts: "1.000", msg: { text: "one" }, threadTs: undefined, broadcast: undefined },
      { channelId: "C1", ts: "2.000", msg: { text: "two" }, threadTs: "1.000", broadcast: true },
    ]);

    await chat.updateMessage("C1", "1.000", { text: "one (edited)" });
    expect(chat.updates).toEqual([{ channelId: "C1", ts: "1.000", msg: { text: "one (edited)" } }]);

    expect(await chat.channelInfo("C404")).toBeNull();
    chat.channels.set("C1", { id: "C1", name: "eng", isPrivate: false });
    expect(await chat.channelInfo("C1")).toEqual({ id: "C1", name: "eng", isPrivate: false });

    expect(await chat.authTest()).toEqual({ team: "fake", botUserId: "UFAKE" });
  });

  it("failNext queues one error per method, consumed FIFO, then the call succeeds again", async () => {
    const chat = new FakeChatProvider();
    chat.failNext("postMessage", new ChatError("rate_limited", "ratelimited", 1000));
    await expect(chat.postMessage("C1", { text: "x" })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(chat.postMessage("C1", { text: "x" })).resolves.toEqual({ ts: "1.000" });
    expect(chat.posts).toHaveLength(1);

    chat.failNext("channelInfo", new ChatError("auth_failed", "missing_scope"));
    chat.failNext("channelInfo", new ChatError("transient", "something_new"));
    await expect(chat.channelInfo("C1")).rejects.toMatchObject({ code: "auth_failed" });
    await expect(chat.channelInfo("C1")).rejects.toMatchObject({ code: "transient" });
    await expect(chat.channelInfo("C1")).resolves.toBeNull();
  });
});
