import { createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { type AssistantAsk, askTranscript } from "../../assistant/ask";
import { ASSISTANT_REQUEST_LIMITS } from "../../assistant/config";
import type { AssistantLessonContext } from "../../assistant/lesson";
import { START_LESSON_TOOL_NAME } from "../../assistant/lessonTool";
import type { AssistantLibraryContext } from "../../assistant/protocol";
import { RECOMMEND_SOUNDS_TOOL } from "../../assistant/recommendation";
import { ASSISTANT_TOOLSET_VERSION } from "../../assistant/tools";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { buildAssistantLibrary } from "../../testing/assistantLibrary";
import { createFakeAssistantClient } from "../../testing/fakeAssistantClient";
import { memoryStorage } from "../../testing/storage";
import type { AssistantScope } from "./assistantScope";
import {
  type AssistantConversation,
  type ConversationEntry,
  continueNote,
  historyOf,
  refreshNote,
  useAssistantConversation,
} from "./useAssistantConversation";

const message = (id: string, text: string): ConversationEntry => ({
  kind: "message",
  id,
  text,
  scopeLabel: "BD",
});
const reply = (id: string, text: string): ConversationEntry => ({
  kind: "reply",
  id,
  text,
  streaming: false,
  stopped: false,
});

describe("the conversation a turn resends", () => {
  it("keeps each message that got a reply, with the reply", () => {
    expect(
      historyOf([
        message("1", "One"),
        reply("2", "Reply"),
        message("3", "Failed"),
        {
          kind: "error",
          id: "4",
          error: { code: "timeout", retryable: true },
          request: null as never,
          origin: null as never,
        },
        message("5", "Stopped early"),
        { kind: "reply", id: "6", text: "", streaming: false, stopped: true },
      ]),
    ).toEqual([
      { role: "user", text: "One" },
      { role: "assistant", text: "Reply" },
    ]);
  });

  it("never resends a reply that failed part-way as the answer (GRV-26)", () => {
    expect(
      historyOf([
        message("1", "Q"),
        {
          kind: "reply",
          id: "2",
          text: "Here is one idea. ",
          streaming: false,
          stopped: false,
          failed: true,
        },
        reply("3", "Here is one idea. Full reply."),
      ]),
    ).toEqual([
      { role: "user", text: "Q" },
      { role: "assistant", text: "Here is one idea. Full reply." },
    ]);
  });

  it("resends a question the reply asked with it, and an answer as what it says (GRV-42)", () => {
    const ask: AssistantAsk = {
      id: "toolu_1",
      question: "Which?",
      options: [{ label: "A" }, { label: "B" }],
      multiSelect: false,
    };
    expect(
      historyOf([
        message("1", "Help"),
        { kind: "reply", id: "2", text: "", streaming: false, stopped: false, ask },
        {
          kind: "message",
          id: "3",
          text: "A",
          scopeLabel: "BD",
          answers: "Which?",
          wire: '[Answer to "Which?"] Picked: A.',
        },
        reply("4", "Going with A."),
      ]),
    ).toEqual([
      { role: "user", text: "Help" },
      { role: "assistant", text: askTranscript(ask) },
      { role: "user", text: '[Answer to "Which?"] Picked: A.' },
      { role: "assistant", text: "Going with A." },
    ]);
  });

  it("leaves room for the new message, in whole exchanges", () => {
    const entries = Array.from({ length: 150 }, (_, index) => [
      message(`m${index}`, `Q${index}`),
      reply(`r${index}`, `A${index}`),
    ]).flat();
    const history = historyOf(entries);
    expect(history.length).toBeLessThan(ASSISTANT_REQUEST_LIMITS.maxMessages);
    expect(history.length % 2).toBe(0);
    expect(history[0]?.role).toBe("user");
    expect(history.at(-1)).toEqual({ role: "assistant", text: "A149" });
  });
});

describe("a conversation that can recommend (GRV-23)", () => {
  const project = createSliceFixtureProject();
  const scope: AssistantScope = {
    level: "track",
    label: "BD",
    catalogScope: "track",
    selection: null,
    track: project.song.tracks[0] ?? null,
  };

  function talk(library?: () => Promise<AssistantLibraryContext | null>) {
    const client = createFakeAssistantClient();
    const onProposal = vi.fn();
    const onRecommendation = vi.fn();
    let conversation: AssistantConversation | undefined;
    const dispose = createRoot((dispose) => {
      conversation = useAssistantConversation({
        client: async () => client,
        project: () => project,
        scope: () => scope,
        canSend: () => true,
        analytics: () =>
          new Analytics({
            transport: createRecordingTransport(),
            storage: memoryStorage(),
          }),
        onProposal,
        onRecommendation,
        ...(library ? { library } : {}),
      });
      return dispose;
    });
    flush();
    if (!conversation) throw new Error("no conversation");
    return { conversation, client, onProposal, onRecommendation, dispose };
  }

  it("sends the library with the turn, and none when it will not load", async () => {
    const library = buildAssistantLibrary();
    const loaded = talk(async () => library);
    loaded.conversation.send("Anything dustier?");
    await vi.waitFor(() => expect(loaded.client.turns).toHaveLength(1));
    expect(loaded.client.last().request.library).toEqual(library);
    loaded.dispose();

    const failing = talk(async () => {
      throw new Error("offline");
    });
    failing.conversation.send("Anything dustier?");
    await vi.waitFor(() => expect(failing.client.turns).toHaveLength(1));
    expect(failing.client.last().request.library).toBeUndefined();
    failing.dispose();
  });

  it("takes recommendations out of a proposal: a card each, and the changes as one", async () => {
    const library = buildAssistantLibrary();
    const { conversation, client, onProposal, onRecommendation, dispose } = talk(
      async () => library,
    );
    conversation.send("Dustier, and slower");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    const recommend = { id: "t1", name: RECOMMEND_SOUNDS_TOOL, input: { packId: "x" } };
    const change = { id: "t2", name: "parameter_set", input: {} };
    client.last().emit({
      type: "proposal",
      proposal: { baseRevision: 0, toolsetVersion: 3, calls: [recommend, change] },
    });
    client.last().done();
    flush();
    const kinds = conversation.entries().map((entry) => entry.kind);
    expect(kinds).toEqual(["message", "proposal", "recommendation"]);
    expect(onProposal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ calls: [change] }),
      expect.anything(),
    );
    expect(onRecommendation).toHaveBeenCalledWith(
      expect.any(String),
      recommend,
      library,
      expect.objectContaining({ text: "Dustier, and slower" }),
    );
    // Refresh asks again for a recommendation, in its words.
    const entry = conversation.entries().find((item) => item.kind === "recommendation");
    expect(conversation.refresh(entry?.id ?? "")).toBe(true);
    await vi.waitFor(() => expect(client.turns).toHaveLength(2));
    expect(client.last().request.messages.at(-1)?.text).toBe("Dustier, and slower");
    dispose();
  });
});

describe("a conversation during a lesson (GRV-43)", () => {
  const project = createSliceFixtureProject();
  const scope: AssistantScope = {
    level: "song",
    label: "Song",
    catalogScope: "song",
    selection: null,
    track: null,
  };
  const lesson: AssistantLessonContext = {
    chapterId: "tour",
    chapter: "Tour the studio",
    biteId: "tour-mixer",
    bite: "The Mixer",
    skill: "balancing tracks",
    biteNumber: 5,
    biteCount: 5,
    moment: "under_way",
    how: null,
    step: "Open the Mixer with 5.",
    changes: [],
    style: null,
    quiz: null,
    next: [],
    track: null,
    passed: [],
    earlier: [],
  };

  it("sends the lesson with each turn while there is one, and starts one the reply names", async () => {
    const client = createFakeAssistantClient();
    const onStartLesson = vi.fn();
    const onProposal = vi.fn();
    let current: AssistantLessonContext | null = lesson;
    let conversation: AssistantConversation | undefined;
    const dispose = createRoot((dispose) => {
      conversation = useAssistantConversation({
        client: async () => client,
        project: () => project,
        scope: () => scope,
        canSend: () => true,
        analytics: () =>
          new Analytics({
            transport: createRecordingTransport(),
            storage: memoryStorage(),
          }),
        lesson: () => current,
        onStartLesson,
        onProposal,
      });
      return dispose;
    });
    flush();
    if (!conversation) throw new Error("no conversation");
    conversation.send("What does pan do?");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    expect(client.last().request.lesson).toEqual(lesson);
    client.last().emit({
      type: "proposal",
      proposal: {
        baseRevision: 0,
        toolsetVersion: ASSISTANT_TOOLSET_VERSION,
        calls: [
          { id: "t1", name: START_LESSON_TOOL_NAME, input: { chapter: "beat" } },
          { id: "t2", name: START_LESSON_TOOL_NAME, input: { chapter: "jazz" } },
        ],
      },
    });
    client.last().done();
    flush();
    expect(onStartLesson).toHaveBeenCalledTimes(1);
    expect(onStartLesson).toHaveBeenCalledWith("beat");
    // Starting a lesson is no proposal, and no card.
    expect(onProposal).not.toHaveBeenCalled();
    expect(conversation.entries().map((entry) => entry.kind)).toEqual(["message"]);

    current = null;
    conversation.send("Thanks");
    await vi.waitFor(() => expect(client.turns).toHaveLength(2));
    expect(client.last().request.lesson).toBeUndefined();
    dispose();
  });

  it("sends an answer a lesson takes only when the lesson could not start", async () => {
    const client = createFakeAssistantClient();
    let starts = false;
    const takeAnswer = vi.fn(() => starts);
    let conversation: AssistantConversation | undefined;
    const dispose = createRoot((dispose) => {
      conversation = useAssistantConversation({
        client: async () => client,
        project: () => project,
        scope: () => scope,
        canSend: () => true,
        analytics: () =>
          new Analytics({
            transport: createRecordingTransport(),
            storage: memoryStorage(),
          }),
        takeAnswer,
      });
      return dispose;
    });
    flush();
    if (!conversation) throw new Error("no conversation");
    const ask: AssistantAsk = {
      id: "ask-lesson",
      question: "Want a first lesson?",
      multiSelect: false,
      options: [{ label: "Let's go" }, { label: "Not now" }],
    };
    const askOnce = async (turns: number) => {
      conversation?.send("Hi");
      await vi.waitFor(() => expect(client.turns).toHaveLength(turns));
      client.last().emit({ type: "ask", ask });
      client.last().done();
      flush();
    };

    // The lesson cannot start: the answer goes to Coproducer as any other.
    await askOnce(1);
    expect(conversation.answerAsk({ picked: [0], text: "" })).toBe(true);
    await vi.waitFor(() => expect(client.turns).toHaveLength(2));
    client.last().done();
    flush();

    // The lesson starts: the answer is shown, and not sent.
    starts = true;
    await askOnce(3);
    expect(conversation.answerAsk({ picked: [0], text: "" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.turns).toHaveLength(3);
    expect(conversation.entries().at(-1)).toMatchObject({
      kind: "message",
      text: "Let's go",
    });
    expect(takeAnswer).toHaveBeenCalledTimes(2);
    dispose();
  });
});

describe("a conversation that recommends a video (GRV-16)", () => {
  const project = createSliceFixtureProject();
  const scope: AssistantScope = {
    level: "song",
    label: "Song",
    catalogScope: "song",
    selection: null,
    track: null,
  };
  const video = {
    videoId: "tH9LHIyJ0c8",
    title: "Acid Basslines",
    channel: "Point Blank",
    reason: "Shows the squelch.",
  };

  it("adds a card per video, logs each shown once, and resends it as the model's own ID", async () => {
    const client = createFakeAssistantClient();
    const transport = createRecordingTransport();
    const analytics = new Analytics({ transport, storage: memoryStorage() });
    let conversation: AssistantConversation | undefined;
    const dispose = createRoot((dispose) => {
      conversation = useAssistantConversation({
        client: async () => client,
        project: () => project,
        scope: () => scope,
        canSend: () => true,
        analytics: () => analytics,
      });
      return dispose;
    });
    flush();
    if (!conversation) throw new Error("no conversation");
    conversation.send("How do I get that acid squelch?");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    client.last().text("Watch this:");
    client.last().emit({ type: "videos", videos: [video] });
    client.last().done();
    flush();
    expect(conversation.entries().map((entry) => entry.kind)).toEqual([
      "message",
      "reply",
      "video",
    ]);
    const shown = transport.events.filter(
      (event) => event.name === "assistant_video_shown",
    );
    expect(shown).toHaveLength(1);
    // Nothing about the video itself reaches analytics.
    expect(JSON.stringify(shown)).not.toContain(video.videoId);
    expect(historyOf(conversation.entries())).toEqual([
      { role: "user", text: "How do I get that acid squelch?" },
      {
        role: "assistant",
        text: `Watch this:\n\n[I recommended the YouTube video ${video.videoId}.]`,
      },
    ]);
    dispose();
  });
});

describe("a proposal that streams its parts (GRV-144)", () => {
  const project = createSliceFixtureProject();
  const scope: AssistantScope = {
    level: "song",
    label: "Song",
    catalogScope: "song",
    selection: null,
    track: null,
  };
  const call = (n: number) => ({
    id: `toolu_${n}`,
    name: "parameter_set",
    input: { value: n },
  });
  const part = (n: number) => ({ index: n, toolsetVersion: 9, call: call(n) });

  function talk() {
    const client = createFakeAssistantClient();
    const onProposal = vi.fn();
    const onProposalPart = vi.fn();
    const onProposalEnded = vi.fn();
    let conversation: AssistantConversation | undefined;
    const dispose = createRoot((dispose) => {
      conversation = useAssistantConversation({
        client: async () => client,
        project: () => project,
        scope: () => scope,
        canSend: () => true,
        analytics: () =>
          new Analytics({
            transport: createRecordingTransport(),
            storage: memoryStorage(),
          }),
        onProposal,
        onProposalPart,
        onProposalEnded,
      });
      return dispose;
    });
    flush();
    if (!conversation) throw new Error("no conversation");
    return { conversation, client, onProposal, onProposalPart, onProposalEnded, dispose };
  }

  it("puts the turn's parts in one entry, which the whole proposal then fills", async () => {
    const { conversation, client, onProposal, onProposalPart, onProposalEnded, dispose } =
      talk();
    conversation.send("Two changes");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    client.last().emit({ type: "part", part: part(0) });
    client.last().emit({ type: "part", part: part(1) });
    flush();
    const proposals = () =>
      conversation.entries().filter((entry) => entry.kind === "proposal");
    expect(proposals()).toHaveLength(1);
    const [entry] = proposals();
    expect(onProposalPart.mock.calls.map(([id, sent]) => [id, sent.index])).toEqual([
      [entry?.id, 0],
      [entry?.id, 1],
    ]);
    const whole = { baseRevision: 0, toolsetVersion: 9, calls: [call(0), call(1)] };
    client.last().emit({ type: "proposal", proposal: whole });
    client.last().done();
    flush();
    expect(proposals()).toHaveLength(1);
    expect(onProposal).toHaveBeenCalledWith(entry?.id, whole, expect.anything());
    expect(onProposalEnded).toHaveBeenCalledWith(entry?.id, "ended");
    dispose();
  });

  it("leaves Try again to the card when the turn fails after parts arrived, and asks for the rest", async () => {
    const { conversation, client, onProposalEnded, dispose } = talk();
    conversation.send("Two changes");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    client.last().emit({ type: "part", part: part(0) });
    client.last().fail({ code: "timeout", retryable: true });
    flush();
    const error = conversation.entries().find((entry) => entry.kind === "error");
    expect(error && conversation.canRetry(error)).toBe(false);
    const entry = conversation
      .entries()
      .find((candidate) => candidate.kind === "proposal");
    expect(onProposalEnded).toHaveBeenCalledWith(entry?.id, "failed");
    const shown = [{ text: "Swing 50% to 58%", applied: true }];
    expect(conversation.continueProposal(entry?.id ?? "", shown)).toBe(true);
    await vi.waitFor(() => expect(client.turns).toHaveLength(2));
    expect(client.last().request.messages.at(-1)?.text).toBe(
      `Two changes\n\n${continueNote(shown)}`,
    );
    // The log shows the producer's words, not the note.
    expect(conversation.entries().at(-2)).toMatchObject({
      kind: "message",
      text: "Two changes",
    });
    dispose();
  });
});

describe("the note Try again sends for the rest of a proposal (GRV-144)", () => {
  it("names the parts shown, which were applied and which are withdrawn", () => {
    const note = continueNote([
      { text: "Bass · new track", applied: true },
      { text: "Bass · 1 bar", applied: false },
    ]);
    expect(note).toBe(
      [
        "[Continue] Your last reply stopped partway, after these parts of its proposal.",
        "Applied, so the song has them now; don't propose them again:",
        "- Bass · new track",
        "Not applied, and withdrawn; propose them again only if the song still needs them:",
        "- Bass · 1 bar",
        "The project description is the whole song as it is now, with every track's ID: build on what it lists. Propose only what is still missing for my request.",
      ].join("\n"),
    );
  });

  it("never says the song has a part the producer applied and then removed", () => {
    const note = refreshNote([
      { text: "Lead · new track", applied: true },
      { text: "Shaker · new track", applied: true, removed: true },
      { text: "Shaker · 2 bars", applied: false },
    ]);
    expect(note).toContain(
      "Applied, so the song has them now; don't propose them again:\n- Lead · new track\nApplied, then removed by me",
    );
    expect(note).toContain(
      "Applied, then removed by me, so the song no longer has them:\n- Shaker · new track\n",
    );
  });

  it("leaves out a group with no parts in it", () => {
    const note = continueNote([{ text: "Bass · 1 bar", applied: false }]);
    expect(note).not.toContain("Applied, so");
    expect(note).toContain("- Bass · 1 bar");
  });
});

describe("a conversation's session health (GRV-103)", () => {
  const project = createSliceFixtureProject();
  const scope: AssistantScope = {
    level: "song",
    label: "Song",
    catalogScope: "song",
    selection: null,
    track: null,
  };

  function talk() {
    const client = createFakeAssistantClient();
    const health = {
      messageSent: vi.fn(() => ({
        session: 1,
        index: health.messageSent.mock.calls.length,
      })),
      turnEnded: vi.fn(),
      proposalOutcome: vi.fn(),
      rated: vi.fn(),
      reset: vi.fn(),
    };
    let conversation: AssistantConversation | undefined;
    const dispose = createRoot((dispose) => {
      conversation = useAssistantConversation({
        client: async () => client,
        project: () => project,
        scope: () => scope,
        canSend: () => true,
        analytics: () =>
          new Analytics({
            transport: createRecordingTransport(),
            storage: memoryStorage(),
          }),
        health,
      });
      return dispose;
    });
    flush();
    if (!conversation) throw new Error("no conversation");
    return { conversation, client, health, dispose };
  }

  it("tells it each message and how each turn ended, numbered by turn, retries included", async () => {
    const { conversation, client, health, dispose } = talk();
    conversation.send("One");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    client.last().text("Fine.");
    client.last().done();
    flush();
    conversation.send("Two");
    await vi.waitFor(() => expect(client.turns).toHaveLength(2));
    client.last().fail({ code: "timeout", retryable: true });
    flush();
    expect(conversation.retry()).toBe(true);
    await vi.waitFor(() => expect(client.turns).toHaveLength(3));
    client.last().emit({
      type: "done",
      stopped: false,
      stopReason: "max_tokens",
      requestsRemaining: null,
    });
    expect(health.messageSent).toHaveBeenCalledTimes(2);
    expect(health.turnEnded.mock.calls).toEqual([
      [
        { kind: "done", stopped: false, stopReason: "end_turn" },
        { session: 1, index: 1 },
      ],
      [
        { kind: "error", code: "timeout" },
        { session: 1, index: 2 },
      ],
      [
        { kind: "done", stopped: false, stopReason: "max_tokens" },
        { session: 1, index: 2 },
      ],
    ]);
    dispose();
  });

  it("sets, changes and clears a reply's rating", async () => {
    const { conversation, client, dispose } = talk();
    conversation.send("One");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    client.last().text("Fine.");
    client.last().done();
    flush();
    const replyId = conversation.entries()[1]?.id ?? "";
    expect(conversation.rateReply(replyId, "down")).toMatchObject({
      sessionTurn: { session: 1, index: 1 },
    });
    flush();
    expect(conversation.entries()[1]).toMatchObject({ rating: "down" });
    conversation.rateReply(replyId, null);
    flush();
    expect(conversation.entries()[1]).not.toHaveProperty("rating");
    expect(conversation.rateReply("nothing", "up")).toBeNull();
    dispose();
  });
});

describe("what a turn says about analytics (GRV-126)", () => {
  const project = createSliceFixtureProject();
  const scope: AssistantScope = {
    level: "track",
    label: "BD",
    catalogScope: "track",
    selection: null,
    track: project.song.tracks[0] ?? null,
  };

  function talk(allowed: boolean) {
    const client = createFakeAssistantClient();
    const consent = new ConsentStore(memoryStorage());
    if (!allowed) consent.optOut();
    const analytics = new Analytics({
      transport: { ...createRecordingTransport(), sessionId: () => "0192f3a1-7c2b" },
      consent,
      storage: memoryStorage(),
    });
    let conversation: AssistantConversation | undefined;
    const dispose = createRoot((dispose) => {
      conversation = useAssistantConversation({
        client: async () => client,
        project: () => project,
        scope: () => scope,
        canSend: () => true,
        analytics: () => analytics,
      });
      return dispose;
    });
    flush();
    if (!conversation) throw new Error("no conversation");
    return { conversation, client, dispose };
  }

  it("sends the consent and the session while product analytics is allowed", async () => {
    const { conversation, client, dispose } = talk(true);
    conversation.send("Make it groove");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    expect(client.last().request.analytics).toEqual({
      productAnalytics: true,
      sessionId: "0192f3a1-7c2b",
    });
    dispose();
  });

  it("says declined, with no session, once it is not", async () => {
    const { conversation, client, dispose } = talk(false);
    conversation.send("Make it groove");
    await vi.waitFor(() => expect(client.turns).toHaveLength(1));
    expect(client.last().request.analytics).toEqual({ productAnalytics: false });
    dispose();
  });
});
