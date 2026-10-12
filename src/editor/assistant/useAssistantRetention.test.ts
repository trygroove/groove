import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import {
  createFailingTransport,
  createRecordingTransport,
} from "../../analytics/transport";
import type { AssistantRetentionClient } from "../../assistant/retentionClient";
import {
  ASSISTANT_DISCLOSURE_VERSION,
  type ReplyRating,
} from "../../assistant/transcripts";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import {
  createFakeRetentionClient,
  type FakeRetentionClient,
} from "../../testing/fakeRetentionClient";
import { memoryStorage } from "../../testing/storage";
import { type AssistantChat, useAssistantChat } from "./useAssistantChat";
import { useAssistantRetention } from "./useAssistantRetention";

const project = createSliceFixtureProject();
const track = project.song.tracks[0] ?? null;

/** Lets the retention client's promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function chatWith(
  retentionClient: FakeRetentionClient,
  options: {
    analytics?: Analytics;
    registered?: boolean;
    internal?: boolean;
    expanded?: boolean;
  } = {},
) {
  const client = createFakeAssistantClient();
  const transport = createRecordingTransport();
  const analytics =
    options.analytics ?? new Analytics({ transport, storage: memoryStorage() });
  const [registered, setRegistered] = createSignal(options.registered ?? true);
  const [expanded, setExpanded] = createSignal(options.expanded ?? true);
  let chat: AssistantChat | undefined;
  const dispose = createRoot((dispose) => {
    chat = useAssistantChat({
      project: () => project,
      view: () => "arrangement",
      sources: () => ({ selection: null, track }),
      account: () => ({ registered: registered() }),
      expanded,
      client: async () => client,
      analytics: () => analytics,
      retention: {
        client: async () => retentionClient,
        internal: () => options.internal ?? false,
      },
    });
    return dispose;
  });
  flush();
  if (!chat) throw new Error("the chat did not start");
  return { chat, client, transport, setRegistered, setExpanded, dispose };
}

describe("the assistant's disclosure gate (GRV-8)", () => {
  it("cannot be messaged until the account has answered the disclosure", async () => {
    const retention = createFakeRetentionClient();
    const { chat, client } = chatWith(retention);
    // Before the answer has even loaded.
    expect(chat.conversation.send("Make it groove")).toBe(false);
    await settle();
    expect(chat.retention?.status()).toBe("ready");
    expect(chat.retention?.answered()).toBe(false);
    expect(chat.conversation.send("Make it groove")).toBe(false);
    chat.setDraft("Make it groove");
    expect(chat.sendDraft()).toBe(false);
    expect(client.turns).toHaveLength(0);

    expect(await chat.retention?.answer(false)).toBe(true);
    flush();
    expect(chat.retention?.answered()).toBe(true);
    expect(chat.conversation.send("Make it groove")).toBe(true);
    await settle();
    expect(client.turns).toHaveLength(1);
  });

  it("stays closed when the answer cannot be loaded, until one is given", async () => {
    const retention = createFakeRetentionClient({ answered: true });
    retention.failCalls(true);
    const { chat, client } = chatWith(retention);
    await settle();
    expect(chat.retention?.status()).toBe("failed");
    expect(chat.conversation.send("hello")).toBe(false);
    expect(await chat.retention?.answer(true)).toBe(false);
    expect(chat.retention?.saveFailed()).toBe(true);
    retention.failCalls(false);
    expect(await chat.retention?.answer(true)).toBe(true);
    expect(chat.conversation.send("hello")).toBe(true);
    await settle();
    expect(client.turns).toHaveLength(1);
  });

  it("reads a stored answer back, so a later session is not asked again", async () => {
    const retention = createFakeRetentionClient({ answered: false });
    const { chat } = chatWith(retention);
    await settle();
    expect(chat.retention?.answered()).toBe(true);
    expect(chat.retention?.retain()).toBe(false);
    // Reading it changed nothing.
    expect(retention.requests).toEqual([{ op: "get" }]);
  });

  it("files every turn under its conversation, a fresh turn ID, the project and the traffic flag", async () => {
    const retention = createFakeRetentionClient({ answered: true });
    const { chat, client } = chatWith(retention, { internal: true });
    await settle();
    chat.conversation.send("one");
    await settle();
    client.last().text("ok");
    client.last().done();
    flush();
    expect(chat.conversation.send("two")).toBe(true);
    await settle();
    const [first, second] = client.turns.map((turn) => turn.request.session);
    expect(first).toMatchObject({ projectId: project.metadata.id, internal: true });
    expect(second?.conversationId).toBe(first?.conversationId);
    expect(second?.turnId).not.toBe(first?.turnId);
  });
});

describe("answering (GRV-8)", () => {
  it("logs assistant_retention_changed once per answer, with the state only", async () => {
    const retention = createFakeRetentionClient();
    const { chat, transport } = chatWith(retention);
    await settle();
    await chat.retention?.answer(true);
    await chat.retention?.answer(false);
    const changed = transport.named("assistant_retention_changed");
    expect(changed.map((event) => event.params?.state)).toEqual(["on", "off"]);
    expect(
      transport.named("feature_first_use").map((event) => event.params?.feature),
    ).toEqual(["assistant_retention"]);
    expect(retention.requests.filter((request) => request.op === "set")).toHaveLength(2);
  });

  it("stores the answer just the same when analytics' transport fails", async () => {
    const retention = createFakeRetentionClient();
    const analytics = new Analytics({
      transport: createFailingTransport(),
      storage: memoryStorage(),
    });
    const { chat } = chatWith(retention, { analytics });
    await settle();
    expect(await chat.retention?.answer(false)).toBe(true);
    expect(chat.retention?.retain()).toBe(false);
    expect(await retention.get()).toMatchObject({ preference: { retain: false } });
  });

  it("stores the answer when analytics itself throws", async () => {
    const retention = createFakeRetentionClient();
    const throwing = {
      log() {
        throw new Error("analytics down");
      },
      logFeatureFirstUse() {
        throw new Error("analytics down");
      },
    } as unknown as Analytics;
    const { chat } = chatWith(retention, { analytics: throwing });
    await settle();
    expect(await chat.retention?.answer(true)).toBe(true);
    expect(await retention.get()).toMatchObject({ preference: { retain: true } });
  });

  it("asks nothing until the assistant is first opened, and once only", async () => {
    const retention = createFakeRetentionClient({ answered: true });
    const { chat, setExpanded } = chatWith(retention, { expanded: false });
    await settle();
    expect(retention.requests).toEqual([]);
    expect(chat.retention?.known()).toBe(false);
    expect(chat.retention?.answered()).toBe(false);

    setExpanded(true);
    flush();
    expect(chat.retention?.known()).toBe(false);
    await settle();
    expect(chat.retention?.known()).toBe(true);
    expect(chat.retention?.answered()).toBe(true);

    setExpanded(false);
    flush();
    setExpanded(true);
    flush();
    await settle();
    expect(retention.requests).toEqual([{ op: "get" }]);
  });

  it("asks nothing of a guest or someone signed out", async () => {
    const retention = createFakeRetentionClient();
    const { chat } = chatWith(retention, { registered: false });
    await settle();
    expect(retention.requests).toEqual([]);
    expect(chat.retention?.answered()).toBe(false);
  });
});

describe("telling a kept turn its rating (GRV-103)", () => {
  /**
   * A retention client whose `rate` calls each wait for the test to settle
   * them, and a stored rating that is whichever call settled last, as two
   * transactions on one turn would leave it.
   */
  function deferredRatings() {
    const calls: { rating: ReplyRating | null; settle(): void }[] = [];
    let stored: ReplyRating | null = null;
    const client: AssistantRetentionClient = {
      get: async () => ({
        preference: {
          schemaVersion: 1,
          retain: true,
          disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
          answeredAt: 0,
        },
        disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
        retentionDays: 30,
      }),
      set: async () => {
        throw new Error("not in this test");
      },
      outcome: async () => {},
      rate: (_turnId, rating) =>
        new Promise<void>((resolve) => {
          calls.push({
            rating,
            settle() {
              stored = rating;
              resolve();
            },
          });
        }),
    };
    return { client, calls, stored: () => stored };
  }

  it("sends one turn's changes one at a time, so the last one clicked is the one kept", async () => {
    const fake = deferredRatings();
    const retention = createRoot(() =>
      useAssistantRetention({
        client: async () => fake.client,
        registered: () => true,
        analytics: () =>
          new Analytics({
            transport: createRecordingTransport(),
            storage: memoryStorage(),
          }),
      }),
    );
    flush();
    await settle();
    expect(retention.retain()).toBe(true);

    retention.reportRating("turn-1", "down");
    retention.reportRating("turn-1", "up");
    retention.reportRating("turn-1", null);
    retention.reportRating("turn-1", "up");
    await settle();
    // Settle whatever is on its way, the latest call first, as a slow first
    // transaction would commit after a quick second one.
    let inFlightAtOnce = 0;
    for (let round = 0; round < 10 && fake.calls.length > 0; round += 1) {
      const outstanding = fake.calls.splice(0);
      inFlightAtOnce = Math.max(inFlightAtOnce, outstanding.length);
      for (const call of outstanding.reverse()) call.settle();
      await settle();
    }
    expect(fake.stored()).toBe("up");
    expect(inFlightAtOnce).toBe(1);
  });

  it("goes on to the next change after a call that failed", async () => {
    const fake = deferredRatings();
    let failing = true;
    const rate = fake.client.rate;
    fake.client.rate = async (turnId, rating) => {
      if (failing) {
        failing = false;
        throw new Error("unavailable");
      }
      return rate(turnId, rating);
    };
    const retention = createRoot(() =>
      useAssistantRetention({
        client: async () => fake.client,
        registered: () => true,
        analytics: () =>
          new Analytics({
            transport: createRecordingTransport(),
            storage: memoryStorage(),
          }),
      }),
    );
    flush();
    await settle();
    retention.reportRating("turn-1", "down");
    retention.reportRating("turn-1", "up");
    await settle();
    expect(fake.calls.map((call) => call.rating)).toEqual(["up"]);
    fake.calls[0]?.settle();
    await settle();
    expect(fake.stored()).toBe("up");
  });
});
