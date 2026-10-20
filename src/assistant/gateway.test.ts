import { describe, expect, it } from "vitest";
import {
  createCommandHistory,
  type RawCommandInput,
  setParameter,
  setTrackFlag,
} from "../commands";
import {
  createDenseStepFixtureProject,
  createReferenceProject,
} from "../domain/fixtures";
import { TRACK_VOLUME } from "../domain/parameters";
import { previewCommands } from "../editor/assistant/askReferences";
import { buildAssistantLibrary } from "../testing/assistantLibrary";
import {
  type CallScript,
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../testing/scriptedAssistantProvider";
import { ASK_PRODUCER_TOOL_NAME, type AskSound } from "./ask";
import {
  ASSISTANT_CALL_LIMITS,
  ASSISTANT_MODELS,
  type AssistantCallLimits,
} from "./config";
import {
  type AssistantCaller,
  type AssistantGatewayDeps,
  pseudonymousUserId,
  runAssistantTurn,
} from "./gateway";
import { historyProposalTarget } from "./historyProposalTarget";
import {
  createInMemoryGuardStores,
  type InMemoryGuardStores,
} from "./inMemoryGuardStores";
import { type AssistantLessonContext, LESSON_BLOCK_HEADING } from "./lesson";
import { type AssistantMemoryContext, REMEMBER_TOOL_NAME } from "./memory";
import { buildAssistantPayload } from "./payload";
import {
  ASSISTANT_PROMPT_VERSION,
  assistantSystemPrompt,
  LIBRARY_BLOCK_HEADING,
  MEMORY_BLOCK_HEADING,
} from "./prompt";
import { validateProposal } from "./proposal";
import { createProposalExecutor } from "./proposalExecutor";
import {
  type AssistantErrorCode,
  AssistantGatewayError,
  type AssistantStreamChunk,
  type AssistantTurnRequest,
  type AssistantTurnResult,
} from "./protocol";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import { ADDED_RESULT, CHANGE_STEPS_SPENT } from "./steps";
import { type AssistantTurnLog, TURN_LOG_KEYS } from "./telemetry";
import {
  ASSISTANT_TOOLSET_VERSION,
  assistantTools,
  bundleTools,
  CREATE_EXAMPLES,
  EXPLAIN_TOOL_NAME,
  NEED_MORE_TOOLS_NAME,
  toolNameFor,
} from "./tools";
import { RECOMMEND_VIDEO_TOOL, type VideoFinder } from "./video";

function call(command: RawCommandInput) {
  return { name: toolNameFor(command.type), input: command.payload };
}

const REFERENCE_REVISION = createReferenceProject().metadata.revision;

const SIGNED_IN: AssistantCaller = {
  uid: "uid-secret-1234",
  signInProvider: "google.com",
};

function request(overrides: Partial<AssistantTurnRequest> = {}): AssistantTurnRequest {
  return {
    projectRevision: REFERENCE_REVISION,
    messages: [{ role: "user", text: "Make the bass hit harder" }],
    context: buildAssistantPayload(createReferenceProject()),
    ...overrides,
  };
}

interface Harness {
  deps: AssistantGatewayDeps;
  logs: AssistantTurnLog[];
  chunks: AssistantStreamChunk[];
  sleeps: number[];
  guards: InMemoryGuardStores;
  provider: ReturnType<typeof createScriptedAssistantProvider>;
}

function harness(
  scripts: readonly CallScript[],
  limits: Partial<AssistantCallLimits> = {},
  continuations: readonly CallScript[] = [],
): Harness {
  const provider = createScriptedAssistantProvider(scripts, continuations);
  const logs: AssistantTurnLog[] = [];
  const sleeps: number[] = [];
  const guards = createInMemoryGuardStores();
  let clock = 1_000;
  return {
    provider,
    guards,
    logs,
    chunks: [],
    sleeps,
    deps: {
      provider,
      guards,
      log: (record) => logs.push(record),
      now: () => {
        clock += 5;
        return clock;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      limits: { ...ASSISTANT_CALL_LIMITS, inactivityTimeoutMs: 200, ...limits },
    },
  };
}

function run(
  h: Harness,
  body: unknown = request(),
  caller: AssistantCaller = SIGNED_IN,
  signal: AbortSignal = new AbortController().signal,
) {
  return runAssistantTurn(h.deps, caller, body, {
    signal,
    onChunk: (chunk) => h.chunks.push(chunk),
  });
}

async function failure(promise: Promise<unknown>): Promise<AssistantGatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AssistantGatewayError) return error;
    throw error;
  }
  throw new Error("expected the turn to fail");
}

async function expectCode(promise: Promise<unknown>, code: AssistantErrorCode) {
  expect((await failure(promise)).code).toBe(code);
}

describe("runAssistantTurn: a completed turn", () => {
  it("streams the reply's text as it arrives and returns the whole of it", async () => {
    const h = harness([replyEvents(["Push the ", "kick ", "up 2 dB."])]);
    const result = await run(h);
    expect(h.chunks).toEqual([
      { type: "text", text: "Push the " },
      { type: "text", text: "kick " },
      { type: "text", text: "up 2 dB." },
    ]);
    expect(result).toEqual({
      text: "Push the kick up 2 dB.",
      stopReason: "end_turn",
      proposal: null,
      ask: null,
      videos: [],
      model: ASSISTANT_MODELS["claude-sonnet-5"].id,
      promptVersion: ASSISTANT_PROMPT_VERSION,
      requestsRemaining: 99,
    });
  });

  it("never streams the model's thinking", async () => {
    const h = harness([replyEvents(["Done."], { withThinking: true })]);
    const result = await run(h);
    expect(result.text).toBe("Done.");
    expect(JSON.stringify(h.chunks)).not.toContain("private reasoning");
  });

  it("returns a refusal with its stop reason", async () => {
    const h = harness([replyEvents(["I can't help"], { stopReason: "refusal" })]);
    expect((await run(h)).stopReason).toBe("refusal");
  });

  // Production QA (GRV-42): a reply that ran out of room came back as a turn
  // with nothing in it, and the panel's empty reply simply vanished.
  it("fails a reply cut off at max_tokens as reply_too_long, and logs it", async () => {
    const h = harness([
      replyEvents(["Here is a boom bap be"], { stopReason: "max_tokens" }),
    ]);
    const error = await failure(run(h));
    expect(error.code).toBe("reply_too_long");
    expect(error.details.retryable).toBe(true);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.outcome).toBe("reply_too_long");
  });

  it("sends the project context and a pseudonymous ID, never the uid", async () => {
    const h = harness([replyEvents(["ok"])]);
    await run(h);
    const sent = h.provider.requests[0];
    expect(sent.system[1].text).toContain(createReferenceProject().metadata.name);
    expect(sent.metadata.user_id).toBe(await pseudonymousUserId(SIGNED_IN.uid as string));
    expect(JSON.stringify(sent)).not.toContain(SIGNED_IN.uid);
  });
});

describe("runAssistantTurn: new IDs (GRV-6)", () => {
  it("gives every turn its own stem for the IDs it creates", async () => {
    const h = harness([replyEvents(["ok"])]);
    await run(h);
    await run(h);
    const [first, second] = h.provider.requests.map(
      (sent) => sent.system.at(-1)?.text ?? "",
    );
    const stemOf = (text: string) => /the stem ([A-Za-z0-9]+),/.exec(text)?.[1];
    expect(stemOf(first)).toHaveLength(17);
    expect(stemOf(second)).toHaveLength(17);
    expect(stemOf(first)).not.toBe(stemOf(second));
  });

  it("takes the stem it is given", async () => {
    const h = harness([replyEvents(["ok"])]);
    await runAssistantTurn(
      { ...h.deps, idStem: () => "Stem0000000000000" },
      SIGNED_IN,
      request(),
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    expect(h.provider.requests[0].system.at(-1)?.text).toContain(
      "trk_Stem00000000000000001",
    );
  });
});

describe("runAssistantTurn: asking the producer (GRV-42)", () => {
  const project = createReferenceProject();
  const [track] = project.song.tracks;
  const muteCall = call(setTrackFlag(track.id, "muted", !track.mixer.muted));
  const askInput = {
    question: "Where should the drop land?",
    context: "The build, bars 13-16",
    options: [
      { label: "Bar 17", description: "Right after the build" },
      { label: "Bar 25" },
    ],
    suggested: 0,
  };
  const askCall = { name: ASK_PRODUCER_TOOL_NAME, input: askInput };

  it("returns an ask_producer call as the turn's question, not a proposal", async () => {
    const h = harness([toolUseEvents("One question first.", [askCall])]);
    const result = await run(h);
    expect(result.stopReason).toBe("tool_use");
    expect(result.proposal).toBeNull();
    expect(result.ask).toEqual({ id: "toolu_1", ...askInput, multiSelect: false });
  });

  it("splits a turn that both asks and proposes", async () => {
    const h = harness([
      toolUseEvents("Muting it, then a question.", [muteCall, askCall]),
    ]);
    const result = await run(h);
    expect(result.proposal?.calls).toEqual([{ id: "toolu_1", ...muteCall }]);
    expect(result.ask?.id).toBe("toolu_2");
  });

  it("keeps the first question when the model asks more than one", async () => {
    const second = { ...askCall, input: { ...askInput, question: "And the tempo?" } };
    const h = harness([toolUseEvents("Two questions.", [askCall, second])]);
    expect((await run(h)).ask?.question).toBe("Where should the drop land?");
  });

  it("keeps a question whose option carries an extra that does not validate", async () => {
    const input = {
      ...askInput,
      options: [
        {
          label: "Bar 17",
          sound: {
            kind: "preview",
            calls: Array.from({ length: 21 }, () => ({
              name: "parameter_set",
              input: {},
            })),
          },
        },
        { label: "Bar 25", ref: { kind: "bars", startBar: 25, endBar: 24 } },
      ],
      memory: "likes drops",
    };
    const h = harness([
      toolUseEvents("A question.", [{ name: ASK_PRODUCER_TOOL_NAME, input }]),
    ]);
    const result = await run(h);
    expect(result.ask?.options).toEqual([{ label: "Bar 17" }, { label: "Bar 25" }]);
  });

  it.each([
    ["one option", { ...askInput, options: [{ label: "Bar 17" }] }],
    [
      "two options with one label",
      { ...askInput, options: [{ label: "Bar 17" }, { label: "bar 17" }] },
    ],
    ["no question", { ...askInput, question: "" }],
  ])("treats a question with %s as a malformed reply", async (_name, input) => {
    const h = harness([
      toolUseEvents("A question.", [{ name: ASK_PRODUCER_TOOL_NAME, input }]),
    ]);
    await expectCode(run(h), "malformed_response");
  });
});

describe("runAssistantTurn: tutorial videos (GRV-16, ADR 0009)", () => {
  const real = "acid bassline tutorial";
  const missing = "a video that is not there";
  const realId = "tH9LHIyJ0c8";
  const videoCall = (query: string, reason = "Shows the squelch.") => ({
    name: RECOMMEND_VIDEO_TOOL,
    input: { query, reason },
  });
  const verifier: VideoFinder = async (query) =>
    query === real
      ? { videoId: realId, title: "Acid Basslines", channel: "Point Blank" }
      : "missing";

  it("offers recommend_video only when the gateway can search YouTube", async () => {
    const without = harness([replyEvents(["ok"])]);
    await run(without);
    expect(without.provider.requests[0].tools.map((tool) => tool.name)).not.toContain(
      RECOMMEND_VIDEO_TOOL,
    );

    const h = harness([replyEvents(["ok"])]);
    h.deps = { ...h.deps, findVideo: verifier };
    await run(h);
    expect(h.provider.requests[0].tools.map((tool) => tool.name)).toContain(
      RECOMMEND_VIDEO_TOOL,
    );
  });

  it("returns the videos its searches find, with their title and channel, and drops the rest", async () => {
    const h = harness([
      toolUseEvents("Watch this.", [videoCall(real), videoCall(missing)]),
    ]);
    const checked: string[] = [];
    h.deps = {
      ...h.deps,
      findVideo: async (query, signal) => {
        checked.push(query);
        return verifier(query, signal);
      },
    };
    const result = await run(h);
    expect(checked.sort()).toEqual([real, missing].sort());
    expect(result.videos).toEqual([
      {
        videoId: realId,
        title: "Acid Basslines",
        channel: "Point Blank",
        reason: "Shows the squelch.",
      },
    ]);
    // A video is not a change to the song.
    expect(result.proposal).toBeNull();
    expect(h.logs[0]).toMatchObject({
      videosShown: 1,
      videosDropped: 1,
      videosUnchecked: 0,
    });
    // The dropped one is said to be left out, in the stream and the result.
    expect(result.text).toMatch(/^Watch this\.\n\nOne of the videos I picked/);
    expect(h.chunks.map((chunk) => chunk.text).join("")).toBe(result.text);
  });

  it("says there is no video when a reply's only video is dropped, rather than ending on nothing", async () => {
    const h = harness([toolUseEvents("", [videoCall(missing)])]);
    h.deps = { ...h.deps, findVideo: verifier };
    const result = await run(h);
    expect(result.videos).toEqual([]);
    expect(result.text).toMatch(/^I couldn't find a video on YouTube/);
    expect(h.chunks.map((chunk) => chunk.text).join("")).toBe(result.text);
    expect(h.logs[0]).toMatchObject({ videosDropped: 1, videosUnchecked: 0 });
  });

  it("adds nothing to a reply whose video is shown", async () => {
    const h = harness([toolUseEvents("The squelch is resonance.", [videoCall(real)])]);
    h.deps = { ...h.deps, findVideo: verifier };
    const result = await run(h);
    expect(result.text).toBe("The squelch is resonance.");
    expect(result.videos).toHaveLength(1);
  });

  it("drops every video when the search is unavailable, and never shows one unchecked", async () => {
    const h = harness([toolUseEvents("Watch this.", [videoCall(real)])]);
    h.deps = {
      ...h.deps,
      findVideo: async () => {
        throw new Error("YouTube is down");
      },
    };
    const result = await run(h);
    expect(result.videos).toEqual([]);
    expect(result.text).toMatch(/^Watch this\.\n\nI couldn't find a video/);
    expect(h.logs[0]).toMatchObject({
      outcome: "completed",
      videosDropped: 1,
      videosUnchecked: 1,
    });
  });

  it("drops a video call made without a finder, and a malformed one unsearched", async () => {
    const h = harness([toolUseEvents("Watch this.", [videoCall(real)])]);
    expect((await run(h)).videos).toEqual([]);

    const checked: string[] = [];
    const g = harness([
      toolUseEvents("Watch this.", [videoCall("x".repeat(500)), videoCall(real)]),
    ]);
    g.deps = {
      ...g.deps,
      findVideo: async (query, signal) => {
        checked.push(query);
        return verifier(query, signal);
      },
    };
    const result = await run(g);
    expect(checked).toEqual([real]);
    expect(result.videos.map((video) => video.videoId)).toEqual([realId]);
  });

  it("keeps the changes a turn proposes beside its video", async () => {
    const tempo = call(setParameter({ scope: "song", parameterId: "song.tempo" }, 120));
    const h = harness([toolUseEvents("Both.", [tempo, videoCall(real)])]);
    h.deps = { ...h.deps, findVideo: verifier };
    const result = await run(h);
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([tempo.name]);
    expect(result.videos).toHaveLength(1);
  });
});

describe("runAssistantTurn: tools and proposals (GRV-4)", () => {
  const project = createReferenceProject();
  const [track] = project.song.tracks;
  const muteCall = call(setTrackFlag(track.id, "muted", !track.mixer.muted));
  const volumeCall = call(
    setParameter({ scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id }, -9),
  );

  it("offers the model every assistant tool on every turn, explain_change and ask_producer", async () => {
    const h = harness([replyEvents(["ok"])]);
    await run(h);
    const sent = h.provider.requests[0];
    expect(sent.tools.map((tool) => tool.name)).toEqual([
      ...assistantTools().map((tool) => tool.name),
      EXPLAIN_TOOL_NAME,
      ASK_PRODUCER_TOOL_NAME,
    ]);
    for (const tool of sent.tools) expect(tool.input_schema.type).toBe("object");
  });

  it("offers recommend_sounds, and the library, only on a turn that carries it (GRV-23)", async () => {
    const without = harness([replyEvents(["ok"])]);
    await run(without);
    const plain = without.provider.requests[0];
    expect(plain.tools.map((tool) => tool.name)).not.toContain(RECOMMEND_SOUNDS_TOOL);
    // The prompt, the project and the turn's ID stem (GRV-6): no library.
    expect(plain.system).toHaveLength(3);
    expect(
      plain.system.some((block) => block.text.startsWith(LIBRARY_BLOCK_HEADING)),
    ).toBe(false);

    const library = buildAssistantLibrary();
    const h = harness([replyEvents(["ok"])]);
    await run(h, request({ library }));
    const sent = h.provider.requests[0];
    expect(sent.tools.map((tool) => tool.name)).toEqual([
      ...assistantTools().map((tool) => tool.name),
      EXPLAIN_TOOL_NAME,
      ASK_PRODUCER_TOOL_NAME,
      RECOMMEND_SOUNDS_TOOL,
    ]);
    // The prompt, the project, the library, then the turn's ID stem (GRV-6).
    expect(sent.system).toHaveLength(4);
    expect(sent.system[2].text).toContain("Dusty Kick");
    expect(sent.system[2].text).toContain(library.packs[0].id);
  });

  it("reads memory and offers remember_producer only on a turn that carries it (GRV-25)", async () => {
    const without = harness([replyEvents(["ok"])]);
    await run(without);
    const plain = without.provider.requests[0];
    expect(plain.tools.map((tool) => tool.name)).not.toContain(REMEMBER_TOOL_NAME);
    expect(
      plain.system.some((block) => block.text.startsWith(MEMORY_BLOCK_HEADING)),
    ).toBe(false);

    const memory: AssistantMemoryContext = {
      taste: ["Techno"],
      artists: "Four Tet",
      experience: "played_around",
      goal: null,
      learn: [],
      gear: ["Ableton Move"],
      notes: [{ id: "note-1", text: "Making more trap lately" }],
      askLater: "goal",
    };
    const h = harness([replyEvents(["ok"])]);
    await run(h, request({ memory }));
    const sent = h.provider.requests[0];
    expect(sent.tools.map((tool) => tool.name)).toContain(REMEMBER_TOOL_NAME);
    for (const tool of sent.tools) expect(tool.input_schema.type).toBe("object");
    // The prompt, the project, the memory, then the turn's ID stem.
    expect(sent.system).toHaveLength(4);
    expect(sent.system[2].text.startsWith(MEMORY_BLOCK_HEADING)).toBe(true);
    expect(sent.system[2].text).toContain("Making more trap lately");
    expect(sent.system[2].text).toContain('"askLater":"goal"');
    expect(sent.system[0].text).toMatch(/You are Coproducer/);
  });

  it("reads the lesson a turn carries, after memory (GRV-43)", async () => {
    const memory: AssistantMemoryContext = {
      taste: ["Hip hop"],
      artists: "",
      experience: "none",
      goal: "first_track",
      learn: [],
      gear: [],
      notes: [],
      askLater: null,
    };
    const lesson: AssistantLessonContext = {
      chapterId: "beat",
      chapter: "Make a beat",
      biteId: "beat-kick",
      bite: "The kick pattern",
      skill: "placing the kick",
      biteNumber: 2,
      biteCount: 6,
      moment: "step_done",
      how: "did_it",
      step: null,
      changes: ["BD's BD: hits added on step 11."],
      style: "boom_bap",
      quiz: null,
      next: [],
      earlier: [],
    };
    const h = harness([replyEvents(["Nice kick."])]);
    await run(h, request({ memory, lesson }));
    const sent = h.provider.requests[0];
    // start_lesson is not offered until the panel starts a lesson from it.
    expect(sent.tools.map((tool) => tool.name)).not.toContain("start_lesson");
    // The prompt, the project, the memory, the lesson, then the turn's ID stem.
    expect(sent.system).toHaveLength(5);
    expect(sent.system[3].text).toContain(LESSON_BLOCK_HEADING);
    expect(sent.system[3].text).toContain("hits added on step 11");
  });

  it("returns a memory proposal among the turn's calls, for the browser to take out", async () => {
    const remember = {
      name: REMEMBER_TOOL_NAME,
      input: { kind: "note", text: "Making more trap lately" },
    };
    const h = harness([toolUseEvents("Shall I remember that?", [remember])]);
    const result = await run(
      h,
      request({
        memory: {
          taste: [],
          artists: "",
          experience: null,
          goal: null,
          learn: [],
          gear: [],
          notes: [],
          askLater: null,
        },
      }),
    );
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      REMEMBER_TOOL_NAME,
    ]);
  });

  it("refuses memory carrying a field it does not name", async () => {
    const h = harness([replyEvents(["ok"])]);
    const error = await failure(
      run(h, {
        ...request(),
        memory: {
          taste: [],
          artists: "",
          experience: null,
          goal: null,
          learn: [],
          gear: [],
          notes: [],
          askLater: null,
          email: "someone@example.com",
        },
      }),
    );
    expect(error.code).toBe("invalid_request");
  });

  it("returns a recommendation among the turn's calls, for the browser to take out", async () => {
    const recommend = {
      name: RECOMMEND_SOUNDS_TOOL,
      input: { packId: "pak_x", soundIds: ["a"], reason: "Dusty." },
    };
    const h = harness([toolUseEvents("Try this.", [recommend])]);
    const result = await run(h, request({ library: buildAssistantLibrary() }));
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      RECOMMEND_SOUNDS_TOOL,
    ]);
  });

  it("returns the tool calls as a proposal at the request's revision", async () => {
    const h = harness([
      toolUseEvents("Muting it and pulling it down.", [muteCall, volumeCall]),
    ]);
    const result = await run(h);
    expect(result.stopReason).toBe("tool_use");
    expect(result.text).toBe("Muting it and pulling it down.");
    expect(result.proposal).toEqual({
      baseRevision: REFERENCE_REVISION,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      calls: [
        { id: "toolu_1", ...muteCall },
        { id: "toolu_2", ...volumeCall },
      ],
    });
    expect(h.logs[0]).toMatchObject({ outcome: "completed", stopReason: "tool_use" });
    // The log carries none of the calls.
    expect(JSON.stringify(h.logs)).not.toContain(track.id);
  });

  it("hands back a proposal the executor validates and applies to the open project", async () => {
    const h = harness([toolUseEvents("Muting it.", [muteCall, volumeCall])]);
    const result = await run(h);
    const history = createCommandHistory(project);
    const executor = createProposalExecutor({
      target: historyProposalTarget(history),
      analytics: { log() {} },
    });
    const proposed = executor.propose(result.proposal);
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));
    expect(proposed.handle.apply().ok).toBe(true);
    expect(history.project.song.tracks[0].mixer.volume).toBe(-9);
    expect(history.entries).toHaveLength(1);
  });

  it("returns no proposal when the only call is an explanation", async () => {
    const h = harness([
      toolUseEvents("Here is why.", [
        { name: EXPLAIN_TOOL_NAME, input: { goal: "Louder", technique: "More gain" } },
      ]),
    ]);
    const result = await run(h);
    expect(result.proposal).toBeNull();
  });

  it("returns a proposal the browser refuses once the project has moved on", async () => {
    const h = harness([toolUseEvents("Muting it.", [muteCall])]);
    const result = await run(h, request({ projectRevision: REFERENCE_REVISION + 1 }));
    expect(result.proposal?.baseRevision).toBe(REFERENCE_REVISION + 1);
    const validation = validateProposal(project, result.proposal);
    expect(validation.ok ? null : validation.issues[0].code).toBe("stale_revision");
  });

  // A turn of one call (maxSteps 1), whose calls go to the browser as they
  // came; a stepped turn refuses them back to the model instead (below).
  it("returns a tool call with no input as an empty object", async () => {
    const events = toolUseEvents("Clearing it.", [{ name: "notes_clear", input: {} }]);
    const h = harness(
      [
        events.map((step) =>
          "event" in step &&
          (step.event as { delta?: { type?: string } }).delta?.type === "input_json_delta"
            ? {
                event: {
                  ...(step.event as object),
                  delta: { type: "input_json_delta", partial_json: "" },
                },
              }
            : step,
        ),
      ],
      { maxSteps: 1 },
    );
    const result = await run(h);
    expect(result.proposal?.calls).toEqual([
      { id: "toolu_1", name: "notes_clear", input: {} },
    ]);
  });

  it("fails a turn whose tool calls were cut off, rather than dropping them silently", async () => {
    const events = toolUseEvents("Muting it.", [muteCall]);
    const h = harness([
      events.map((step) =>
        "event" in step && (step.event as { type: string }).type === "message_delta"
          ? {
              event: {
                type: "message_delta",
                delta: { stop_reason: "max_tokens" },
                usage: { output_tokens: 20 },
              },
            }
          : step,
      ),
    ]);
    await expectCode(run(h), "reply_too_long");
  });

  // The tools stream eagerly, so the API no longer checks their input (GRV-6):
  // input that is broken or cut short is the model's mistake, a proposal the
  // browser refuses, never a garbled reply.
  it.each([
    ["input that is not JSON", '{"track', '{"track'],
    ["input that is not an object", "[1, 2]", [1, 2]],
  ])("returns %s as a proposal the browser refuses", async (_label, json, input) => {
    const events = toolUseEvents("Muting it.", [muteCall]);
    const h = harness(
      [
        events.map((step, index) =>
          "event" in step &&
          (step.event as { delta?: { type?: string } }).delta?.type === "input_json_delta"
            ? {
                event: {
                  ...(step.event as object),
                  delta: {
                    type: "input_json_delta",
                    // The whole input in the first piece, nothing in the second.
                    partial_json:
                      (events[index - 1] as { event: { type: string } }).event.type ===
                      "content_block_start"
                        ? json
                        : "",
                  },
                },
              }
            : step,
        ),
      ],
      { maxSteps: 1 },
    );
    const result = await run(h);
    expect(result.proposal?.calls).toEqual([
      { id: "toolu_1", name: muteCall.name, input },
    ]);
    expect(h.logs[0]).toMatchObject({ outcome: "completed", failures: [] });
    const validation = validateProposal(project, result.proposal);
    expect(validation.ok ? null : validation.issues[0].code).toBe("invalid_payload");
  });

  it.each([
    [
      "a tool_use stop with no tool call",
      () => replyEvents(["Muting it."], { stopReason: "tool_use" }),
    ],
    [
      "a text delta inside a tool call",
      (steps: CallScript) =>
        steps.map((step) =>
          "event" in step &&
          (step.event as { delta?: { type?: string } }).delta?.type === "input_json_delta"
            ? {
                event: {
                  ...(step.event as object),
                  delta: { type: "text_delta", text: "hi" },
                },
              }
            : step,
        ),
    ],
  ] satisfies [string, (steps: CallScript) => CallScript][])(
    "fails as malformed on %s",
    async (_label, mangle) => {
      const h = harness([mangle(toolUseEvents("Muting it.", [muteCall]))]);
      await expectCode(run(h), "malformed_response");
      expect(h.logs[0].failures[0]).toBe("malformed");
    },
  );
});

describe("runAssistantTurn: auth", () => {
  it("refuses a caller with no account before calling the provider", async () => {
    const h = harness([replyEvents(["ok"])]);
    await expectCode(
      run(h, request(), { uid: null, signInProvider: null }),
      "unauthenticated",
    );
    expect(h.provider.requests).toHaveLength(0);
    expect(h.logs.map((log) => log.outcome)).toEqual(["unauthenticated"]);
  });

  it("refuses a guest (anonymous) session", async () => {
    const h = harness([replyEvents(["ok"])]);
    await expectCode(
      run(h, request(), { uid: "guest", signInProvider: "anonymous" }),
      "unauthenticated",
    );
    expect(h.provider.requests).toHaveLength(0);
  });
});

describe("runAssistantTurn: the request", () => {
  it("refuses a context field ADR 0007's allowlist does not name", async () => {
    const h = harness([replyEvents(["ok"])]);
    const body = request();
    const leaky = {
      ...body,
      context: { ...body.context, assetUrl: "https://storage.example/sound.wav" },
    };
    await expectCode(run(h, leaky), "invalid_request");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("refuses a library carrying a field the allowlist does not name", async () => {
    const h = harness([replyEvents(["ok"])]);
    const library = buildAssistantLibrary();
    (library.packs[0] as unknown as Record<string, unknown>).manifestPath = "/x.json";
    const error = await failure(run(h, request({ library })));
    expect(error.code).toBe("invalid_request");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("refuses a conversation that does not end with the user", async () => {
    const h = harness([replyEvents(["ok"])]);
    const body = request({
      messages: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
    });
    await expectCode(run(h, body), "invalid_request");
  });

  it("resends a bounded history, oldest messages dropped, newest kept", async () => {
    const h = harness([replyEvents(["ok"])]);
    const long = "x".repeat(7_900);
    const messages = Array.from({ length: 41 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: index === 40 ? "the newest" : long,
    }));
    await run(h, request({ messages }));
    const sent = h.provider.requests[0].messages;
    expect(sent.length).toBeLessThan(messages.length);
    expect(sent[0].role).toBe("user");
    expect(sent[sent.length - 1].content).toBe("the newest");
    expect(h.logs[0].historyDropped).toBe(messages.length - sent.length);
  });
});

describe("runAssistantTurn: timeout", () => {
  const track = createReferenceProject().song.tracks[0];
  const muteCall = call(setTrackFlag(track.id, "muted", !track.mixer.muted));

  it("abandons a provider call that takes too long, without retrying", async () => {
    const h = harness([[...replyEvents(["Partly"]).slice(0, 2), { hang: true }]], {
      inactivityTimeoutMs: 20,
    });
    await expectCode(run(h), "timeout");
    expect(h.provider.requests).toHaveLength(1);
    expect(h.provider.aborted).toBe(1);
    expect(h.logs[0]).toMatchObject({ outcome: "timeout", attempts: 1 });
  });

  // GRV-42: a turn that streams no text for minutes (thinking, a large
  // proposal) still tells the browser it is alive, and stops once it ends.
  it("sends empty heartbeat chunks while a silent turn runs, and none after", async () => {
    const [start, ...rest] = replyEvents(["Done."]);
    const h = harness([[start, { wait: 60 }, ...rest]], {
      inactivityTimeoutMs: 1_000,
      heartbeatIntervalMs: 10,
    });
    expect((await run(h)).text).toBe("Done.");
    const beats = h.chunks.filter((chunk) => chunk.text === "");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    const sent = h.chunks.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.chunks).toHaveLength(sent);
  });

  it("lets a reply that keeps streaming run past the timeout", async () => {
    // Every gap is under the 40 ms limit, the whole reply well over it.
    const [start, block, ...rest] = replyEvents(["a", "b", "c", "d", "e", "f"]);
    const paced = rest.flatMap((step) => [{ wait: 15 }, step]);
    const h = harness([[start, block, ...paced]], { inactivityTimeoutMs: 40 });
    const started = Date.now();
    expect((await run(h)).text).toBe("abcdef");
    expect(Date.now() - started).toBeGreaterThan(40);
    expect(h.logs[0]).toMatchObject({ outcome: "completed", attempts: 1 });
  });

  // GRV-6: a long think or a large proposal streams no reply text for a
  // while, but every delta is the provider still working.
  it.each([
    ["thinking", "thinking", "thinking_delta", "thinking"],
    ["a tool's input", "tool_use", "input_json_delta", "partial_json"],
  ] as const)(
    "lets a call that keeps streaming %s run past the timeout",
    async (_label, blockType, deltaType, field) => {
      const [start, ...rest] = toolUseEvents("Muting it.", [muteCall]);
      const block = {
        event: {
          type: "content_block_start",
          index: 9,
          content_block:
            blockType === "tool_use"
              ? { type: "tool_use", id: "toolu_9", name: muteCall.name, input: {} }
              : { type: "thinking" },
        },
      };
      // Each gap is under the 40 ms limit, the whole stream well over it.
      const pieces =
        blockType === "tool_use"
          ? (() => {
              const json = JSON.stringify(muteCall.input);
              const size = Math.ceil(json.length / 6);
              return Array.from({ length: 6 }, (_, i) =>
                json.slice(i * size, (i + 1) * size),
              );
            })()
          : ["a", "b", "c", "d", "e", "f"];
      const deltas = pieces.flatMap((piece) => [
        { wait: 15 },
        {
          event: {
            type: "content_block_delta",
            index: 9,
            delta: { type: deltaType, [field]: piece },
          },
        },
      ]);
      const h = harness(
        [
          [
            start,
            block,
            ...deltas,
            { event: { type: "content_block_stop", index: 9 } },
            ...rest,
          ],
        ],
        { inactivityTimeoutMs: 40, maxSteps: 1 },
      );
      const started = Date.now();
      const result = await run(h);
      expect(Date.now() - started).toBeGreaterThan(40);
      expect(h.logs[0]).toMatchObject({ outcome: "completed", attempts: 1 });
      expect(result.text).toBe("Muting it.");
      expect(result.proposal?.calls.length).toBe(blockType === "tool_use" ? 2 : 1);
    },
  );

  it("times out a call that goes quiet after streaming for a while", async () => {
    const [start, block, first, second] = replyEvents(["a", "b"]);
    const h = harness(
      [[start, block, { wait: 15 }, first, { wait: 15 }, second, { hang: true }]],
      { inactivityTimeoutMs: 40 },
    );
    await expectCode(run(h), "timeout");
    expect(h.provider.aborted).toBe(1);
  });
});

describe("runAssistantTurn: cancellation", () => {
  it("aborts the provider call when the browser goes away mid-reply", async () => {
    const controller = new AbortController();
    const h = harness([[...replyEvents(["First "]).slice(0, 3), { hang: true }]]);
    const turn = runAssistantTurn(h.deps, SIGNED_IN, request(), {
      signal: controller.signal,
      onChunk: (chunk) => {
        h.chunks.push(chunk);
        controller.abort();
      },
    });
    await expectCode(turn, "cancelled");
    expect(h.chunks).toEqual([{ type: "text", text: "First " }]);
    expect(h.provider.aborted).toBe(1);
    expect(h.logs[0].outcome).toBe("cancelled");
  });

  it("does not call the provider at all for a request already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([replyEvents(["ok"])]);
    await expectCode(run(h, request(), SIGNED_IN, controller.signal), "cancelled");
    expect(h.provider.requests).toHaveLength(0);
  });
});

describe("runAssistantTurn: malformed stream", () => {
  const start = replyEvents(["x"])[0];

  const RETRIED = ASSISTANT_CALL_LIMITS.maxAttempts;
  it.each([
    ["an event that is not an object", [start, { event: "garbage" }], RETRIED],
    [
      "a known event in the wrong shape",
      [start, { event: { type: "content_block_delta", index: "zero", delta: {} } }],
      RETRIED,
    ],
    [
      "text before the message starts",
      [
        {
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text" },
          },
        },
      ],
      RETRIED,
    ],
    [
      "a tool call with no ID or name",
      [
        start,
        {
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use" },
          },
        },
      ],
      RETRIED,
    ],
    ["an empty reply", replyEvents([]), RETRIED],
    // This one has already streamed text, so it is not retried.
    ["a stream that ends without message_stop", replyEvents(["cut"]).slice(0, 4), 1],
  ] satisfies [string, CallScript, number][])("fails on %s", async (_, script, calls) => {
    const h = harness([script]);
    await expectCode(run(h), "malformed_response");
    expect(h.provider.requests).toHaveLength(calls);
    expect(h.logs[0].failures).toEqual(Array(calls).fill("malformed"));
  });

  it.each(["pause_turn", "a_reason_from_the_future"])(
    "does not retry a reply that stops for %s, which a turn never has",
    async (stopReason) => {
      // No text has streamed, so only the stop reason keeps this from a retry.
      const h = harness([replyEvents([], { stopReason }), replyEvents(["unused"])]);
      await expectCode(run(h), "provider_error");
      expect(h.provider.requests).toHaveLength(1);
      expect(h.logs[0]).toMatchObject({
        outcome: "provider_error",
        attempts: 1,
        failures: ["unsupported_stop"],
      });
    },
  );

  it("skips an event type it does not know, as the API asks", async () => {
    const events = replyEvents(["fine"]);
    events.splice(1, 0, { event: { type: "some_future_event", data: 1 } });
    const h = harness([events]);
    expect((await run(h)).text).toBe("fine");
  });

  it("recovers when a retry streams cleanly", async () => {
    const h = harness([[{ event: "garbage" }], replyEvents(["second time"])]);
    expect((await run(h)).text).toBe("second time");
    expect(h.logs[0]).toMatchObject({ outcome: "completed", attempts: 2 });
  });

  it("does not retry once text has reached the browser", async () => {
    const h = harness([[...replyEvents(["half a reply"]).slice(0, 3), { event: 42 }]]);
    await expectCode(run(h), "malformed_response");
    expect(h.provider.requests).toHaveLength(1);
  });
});

describe("runAssistantTurn: provider error", () => {
  it("retries a transient failure with backoff, then succeeds", async () => {
    const h = harness([
      [{ fail: "overloaded", status: 529 }],
      [{ fail: "rate_limited", status: 429 }],
      replyEvents(["third time lucky"]),
    ]);
    expect((await run(h)).text).toBe("third time lucky");
    expect(h.sleeps).toEqual([
      ASSISTANT_CALL_LIMITS.retryBackoffMs,
      ASSISTANT_CALL_LIMITS.retryBackoffMs * 2,
    ]);
    expect(h.logs[0]).toMatchObject({
      attempts: 3,
      failures: ["overloaded", "rate_limited"],
    });
  });

  it("gives up as unavailable after the last attempt", async () => {
    const h = harness([[{ fail: "server_error", status: 500 }]]);
    const error = await failure(run(h));
    expect(error.code).toBe("provider_unavailable");
    expect(error.details).toEqual({ code: "provider_unavailable", retryable: true });
    expect(h.provider.requests).toHaveLength(ASSISTANT_CALL_LIMITS.maxAttempts);
  });

  it("never retries a request the provider rejected", async () => {
    const h = harness([[{ fail: "rejected", status: 400 }], replyEvents(["unused"])]);
    const error = await failure(run(h));
    expect(error.code).toBe("provider_error");
    expect(error.details.retryable).toBe(false);
    expect(h.provider.requests).toHaveLength(1);
    expect(h.logs[0].providerStatus).toBe(400);
  });
});

describe("runAssistantTurn: redacted telemetry", () => {
  const SECRETS = [
    "Secret Project Name",
    "Track named for a person",
    "my private message",
    "assistant said something private",
    SIGNED_IN.uid as string,
  ];

  function secretRequest(): AssistantTurnRequest {
    const body = request({
      messages: [
        { role: "user", text: "earlier" },
        { role: "assistant", text: "assistant said something private" },
        { role: "user", text: "my private message" },
      ],
    });
    return {
      ...body,
      context: {
        ...body.context,
        projectName: "Secret Project Name",
        tracks: body.context.tracks.map((track) => ({
          ...track,
          name: "Track named for a person",
        })),
      },
    };
  }

  it.each([
    ["a completed turn", [replyEvents(["a reply that is also private"])]],
    ["a failed turn", [[{ fail: "rejected", status: 400 }]]],
    [
      "a malformed turn",
      [[{ event: { type: "message_start", message: "Secret Project Name" } }]],
    ],
  ] satisfies [string, CallScript[]][])(
    "logs one record of codes and counts for %s",
    async (_, scripts) => {
      const h = harness(scripts);
      await run(h, secretRequest()).catch(() => {});
      expect(h.logs).toHaveLength(1);
      expect(Object.keys(h.logs[0]).sort()).toEqual([...TURN_LOG_KEYS].sort());
      const serialized = JSON.stringify(h.logs);
      for (const secret of [...SECRETS, "a reply that is also private"]) {
        expect(serialized).not.toContain(secret);
      }
    },
  );

  it("logs a failure it does not know as an internal error", async () => {
    const h = harness([replyEvents(["ok"])]);
    h.guards.reserveCall = async () => {
      throw new Error("Firestore unreachable for Secret Project Name");
    };
    await expect(run(h)).rejects.toThrow();
    expect(h.logs.map((log) => log.outcome)).toEqual(["internal_error"]);
    expect(JSON.stringify(h.logs)).not.toContain("Secret Project Name");
  });

  it("counts tokens over every attempt", async () => {
    const h = harness([
      [...replyEvents(["x"], { inputTokens: 50 }).slice(0, 1), { fail: "network" }],
      replyEvents(["ok"], { inputTokens: 70, outputTokens: 9 }),
    ]);
    await run(h);
    expect(h.logs[0]).toMatchObject({ inputTokens: 120, outputTokens: 10 });
  });
});

describe("runAssistantTurn: a turn in steps", () => {
  const project = createReferenceProject();
  const [track] = project.song.tracks;
  const muteCall = call(setTrackFlag(track.id, "muted", !track.mixer.muted));
  const volumeCall = call(
    setParameter({ scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id }, -9),
  );
  const explainCall = {
    name: EXPLAIN_TOOL_NAME,
    input: { goal: "A quieter track", technique: "Pull the fader down" },
  };

  /** `script` with a signed thinking block before its stop. */
  function withThinking(script: CallScript): CallScript {
    const thinking = [
      {
        event: {
          type: "content_block_start",
          index: 9,
          content_block: { type: "thinking" },
        },
      },
      {
        event: {
          type: "content_block_delta",
          index: 9,
          delta: { type: "thinking_delta", thinking: "Mute first." },
        },
      },
      {
        event: {
          type: "content_block_delta",
          index: 9,
          delta: { type: "signature_delta", signature: "sig-1" },
        },
      },
      { event: { type: "content_block_stop", index: 9 } },
    ];
    return [script[0], ...thinking, ...script.slice(1)];
  }

  it("goes on after change calls until the proposal is explained, one paragraph a step", async () => {
    const h = harness([toolUseEvents("First I'll mute the track.", [muteCall])], {}, [
      toolUseEvents("Next, its volume.", [volumeCall, explainCall]),
    ]);
    const result = await run(h);
    expect(h.provider.requests).toHaveLength(2);
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      muteCall.name,
      volumeCall.name,
      EXPLAIN_TOOL_NAME,
    ]);
    expect(result.text).toBe("First I'll mute the track.\n\nNext, its volume.");
    expect(
      h.chunks.map((chunk) => (chunk.type === "text" ? chunk.text : "")).join(""),
    ).toBe(result.text);
    expect(result.stopReason).toBe("tool_use");
    expect(h.logs[0]).toMatchObject({ outcome: "completed", attempts: 2 });
  });

  it("sends the step back, thinking unchanged, and answers each call", async () => {
    const h = harness(
      [withThinking(toolUseEvents("First I'll mute the track.", [muteCall]))],
      {},
      [toolUseEvents("Done.", [explainCall])],
    );
    await run(h);
    const [assistant, answers] = h.provider.requests[1].messages.slice(-2);
    expect(assistant).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "First I'll mute the track." },
        { type: "tool_use", id: "toolu_1", name: muteCall.name, input: muteCall.input },
        { type: "thinking", thinking: "Mute first.", signature: "sig-1" },
      ],
    });
    expect(answers).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: ADDED_RESULT }],
    });
  });

  it("ends the turn when a later step has nothing more to say", async () => {
    // The scripted provider ends a continued turn once its script runs out.
    const h = harness([toolUseEvents("Muting it.", [muteCall])]);
    const result = await run(h);
    expect(h.provider.requests).toHaveLength(2);
    expect(result.text).toBe("Muting it.");
    expect(result.proposal?.calls).toEqual([{ id: "toolu_1", ...muteCall }]);
  });

  it("takes one step when the reply explains, asks or changes nothing", async () => {
    const explained = harness([toolUseEvents("Muting it.", [muteCall, explainCall])]);
    await run(explained);
    expect(explained.provider.requests).toHaveLength(1);
    const plain = harness([replyEvents(["Nothing to change."])]);
    await run(plain);
    expect(plain.provider.requests).toHaveLength(1);
  });

  it("refuses a call that does not fit its tool back to the model, and keeps the corrected one", async () => {
    const h = harness(
      [toolUseEvents("Muting it.", [{ name: muteCall.name, input: { flag: "muted" } }])],
      {},
      [toolUseEvents("Fixed.", [muteCall, explainCall])],
    );
    const result = await run(h);
    const answers = h.provider.requests[1].messages.at(-1);
    expect(answers?.content).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_1", is_error: true }),
    ]);
    expect(JSON.stringify(answers?.content)).toContain(
      "Refused, not added to the proposal",
    );
    expect(result.proposal?.calls.map((entry) => entry.input)).toEqual([
      muteCall.input,
      explainCall.input,
    ]);
  });

  it("hands the last step allowed on as it came", async () => {
    const h = harness([toolUseEvents("First.", [muteCall])], { maxSteps: 2 }, [
      toolUseEvents("Second.", [volumeCall]),
      toolUseEvents("Third.", [muteCall]),
    ]);
    const result = await run(h);
    expect(h.provider.requests).toHaveLength(2);
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      muteCall.name,
      volumeCall.name,
    ]);
  });

  it("counts every step against the account's requests", async () => {
    const h = harness([toolUseEvents("First.", [muteCall])], {}, [
      toolUseEvents("Done.", [explainCall]),
    ]);
    const before = await run(harness([replyEvents(["ok"])]));
    const after = await run(h);
    expect(after.requestsRemaining).toBe((before.requestsRemaining ?? 0) - 1);
  });
});

describe("runAssistantTurn: streaming proposal parts (GRV-144)", () => {
  const project = createReferenceProject();
  const [track] = project.song.tracks;
  const muteCall = call(setTrackFlag(track.id, "muted", !track.mixer.muted));
  const volumeCall = call(
    setParameter({ scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id }, -9),
  );
  const explainCall = {
    name: EXPLAIN_TOOL_NAME,
    input: { goal: "A quieter track", technique: "Pull the fader down" },
  };
  /** What reached the browser, in order: text as itself, a part by its index and tool. */
  const stream = (h: Harness) =>
    h.chunks.flatMap((chunk) =>
      chunk.part
        ? [`part ${chunk.part.index}: ${chunk.part.call.name}`]
        : chunk.text
          ? [chunk.text]
          : [],
    );

  it("streams each accepted change call, in call order, as its step is answered", async () => {
    const h = harness([toolUseEvents("First I'll mute the track.", [muteCall])], {}, [
      toolUseEvents("Next, its volume.", [volumeCall, explainCall]),
    ]);
    const result = await run(h);
    expect(stream(h)).toEqual([
      "First I'll mute the track.",
      `part 0: ${muteCall.name}`,
      "\n\nNext, its volume.",
      `part 1: ${volumeCall.name}`,
    ]);
    const parts = h.chunks.flatMap((chunk) => (chunk.part ? [chunk] : []));
    expect(parts.every((chunk) => chunk.text === "")).toBe(true);
    expect(parts[0]?.part).toEqual({
      index: 0,
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
      call: { id: "toolu_1", ...muteCall },
    });
    // The whole proposal still comes back, explanation and all.
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      muteCall.name,
      volumeCall.name,
      EXPLAIN_TOOL_NAME,
    ]);
  });

  it("never streams a call it refuses back to the model, only the corrected one", async () => {
    const h = harness(
      [toolUseEvents("Muting it.", [{ name: muteCall.name, input: { flag: "muted" } }])],
      {},
      [toolUseEvents("Fixed.", [muteCall, explainCall])],
    );
    await run(h);
    const parts = h.chunks.flatMap((chunk) => (chunk.part ? [chunk.part] : []));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ index: 0, call: { input: muteCall.input } });
  });

  it("never streams a last step's call that does not fit its tool, though the proposal carries it", async () => {
    const h = harness([
      toolUseEvents("Muting it.", [
        { name: muteCall.name, input: { flag: "muted" } },
        volumeCall,
        explainCall,
      ]),
    ]);
    const result = await run(h);
    expect(stream(h)).toEqual(["Muting it.", `part 0: ${volumeCall.name}`]);
    expect(result.proposal?.calls).toHaveLength(3);
  });

  it("streams nothing for a reply that proposes nothing", async () => {
    const h = harness([replyEvents(["Nothing to change."])]);
    await run(h);
    expect(h.chunks.some((chunk) => chunk.part)).toBe(false);
  });
});

describe("runAssistantTurn: compact notes (GRV-131)", () => {
  const project = createReferenceProject();
  const noteClip = project.clips.find((clip) => clip.content.kind === "notes");
  if (!noteClip) throw new Error("the reference project has a note clip");
  const explainCall = {
    name: EXPLAIN_TOOL_NAME,
    input: { goal: "A fuller part", technique: "Fill the gaps" },
  };

  it("writes the turn's notes out as note events, numbered from its stem in call order", async () => {
    const addCall = {
      name: "note_add",
      input: { clipId: noteClip.id, notes: [[0, 40, 96, 0.8]] },
    };
    const clipCall = {
      name: "clip_create",
      input: {
        id: "clp_Stem00000000000000001",
        trackId: noteClip.trackId,
        name: "Answer",
        color: "#808080",
        lengthTicks: 768,
        content: {
          kind: "notes",
          events: [
            [0, 43, 192, 0.7],
            [384, 45, 192, 0.6, 0.5],
          ],
        },
      },
    };
    const h = harness([toolUseEvents("First a note.", [addCall])], {}, [
      toolUseEvents("Then an answer.", [clipCall, explainCall]),
    ]);
    const result = await runAssistantTurn(
      { ...h.deps, idStem: () => "Stem0000000000000" },
      SIGNED_IN,
      request(),
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    const [added, created] = result.proposal?.calls ?? [];
    expect(added.input).toEqual({
      clipId: noteClip.id,
      notes: [
        {
          id: "evt_Stem0000000000000n001",
          trigger: { kind: "pitch", pitch: 40 },
          startTicks: 0,
          durationTicks: 96,
          velocity: 0.8,
          probability: null,
        },
      ],
    });
    expect(
      (created.input as { content: { events: { id: string; probability: unknown }[] } })
        .content.events,
    ).toMatchObject([
      { id: "evt_Stem0000000000000n002", probability: null },
      { id: "evt_Stem0000000000000n003", probability: 0.5 },
    ]);
    // What the browser receives is ordinary payloads, and it applies.
    const validation = validateProposal(project, result.proposal);
    expect(validation.ok).toBe(true);
    // The model was offered the compact notes, and saw its own call back as sent.
    const offered = h.provider.requests[0].tools.find((tool) => tool.name === "note_add");
    expect(JSON.stringify(offered?.input_schema)).toContain("prefixItems");
    const [assistant] = h.provider.requests[1].messages.slice(-2);
    expect(JSON.stringify(assistant)).toContain("[0,40,96,0.8]");
  });

  it("keeps the notes it numbers apart from the note IDs the model makes, so the turn applies", async () => {
    // A turn that writes notes in two clips and then duplicates them: the
    // gateway numbers the notes it writes out, and notes_duplicate's newIds
    // are the model's own, from the same stem, in its counter of digits.
    const stem = "Stem0000000000000";
    const clipId = "clp_Stem00000000000000001";
    const addCall = {
      name: "note_add",
      input: {
        clipId: noteClip.id,
        notes: [
          [0, 40, 96, 0.8],
          [96, 43, 96, 0.8],
        ],
      },
    };
    const clipCall = {
      name: "clip_create",
      input: {
        id: clipId,
        trackId: noteClip.trackId,
        name: "Answer",
        color: "#808080",
        lengthTicks: 768,
        content: { kind: "notes", events: [[0, 43, 192, 0.7]] },
      },
    };
    const added = ["evt_Stem0000000000000n001", "evt_Stem0000000000000n002"];
    const duplicateAdded = {
      name: "notes_duplicate",
      input: {
        clipId: noteClip.id,
        eventIds: added,
        offsetTicks: 192,
        newIds: ["evt_Stem00000000000000001", "evt_Stem00000000000000002"],
      },
    };
    const duplicateClip = {
      name: "notes_duplicate",
      input: {
        clipId,
        eventIds: null,
        offsetTicks: 384,
        newIds: ["evt_Stem00000000000000003"],
      },
    };
    const h = harness([toolUseEvents("Notes first.", [addCall, clipCall])], {}, [
      toolUseEvents("Then twice.", [duplicateAdded, duplicateClip, explainCall]),
    ]);
    const result = await runAssistantTurn(
      { ...h.deps, idStem: () => stem },
      SIGNED_IN,
      request(),
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    // The model was told the IDs its new notes were given.
    const answers = JSON.stringify(h.provider.requests[1].messages.at(-1));
    expect(answers).toContain(`count up from ${added[0]} to ${added[1]}`);
    expect(answers).toContain("Its note's ID is evt_Stem0000000000000n003.");

    const history = createCommandHistory(project);
    const executor = createProposalExecutor({
      target: historyProposalTarget(history),
      analytics: { log() {} },
    });
    const proposed = executor.propose(result.proposal);
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));
    expect(proposed.handle.apply().ok).toBe(true);
    const idsIn = (id: string) => {
      const clip = history.project.clips.find((entry) => entry.id === id);
      return clip?.content.kind === "notes" ? clip.content.events.map((e) => e.id) : [];
    };
    expect(idsIn(noteClip.id)).toEqual(
      expect.arrayContaining([...added, ...duplicateAdded.input.newIds]),
    );
    expect(idsIn(clipId)).toEqual([
      "evt_Stem0000000000000n003",
      "evt_Stem00000000000000003",
    ]);
  });

  describe("a note ID the model makes in the gateway's counter", () => {
    const stem = "Stem0000000000000";
    const firstAdd = {
      name: "note_add",
      input: {
        clipId: noteClip.id,
        notes: [
          [0, 40, 96, 0.8],
          [96, 43, 96, 0.8],
        ],
      },
    };
    const secondAdd = {
      name: "note_add",
      input: { clipId: noteClip.id, notes: [[384, 45, 96, 0.8]] },
    };
    // The model kept counting from the IDs it was told: n001, n002, so n003.
    const duplicateAt = (newIds: string[]) => ({
      name: "notes_duplicate",
      input: {
        clipId: noteClip.id,
        eventIds: [`evt_${stem}n001`],
        offsetTicks: 192,
        newIds,
      },
    });
    const turn = (h: Harness) =>
      runAssistantTurn({ ...h.deps, idStem: () => stem }, SIGNED_IN, request(), {
        signal: new AbortController().signal,
        onChunk: () => {},
      });
    const noteIdsOf = (result: { proposal: AssistantTurnResult["proposal"] }) =>
      (result.proposal?.calls ?? []).flatMap((call) => {
        const input = call.input as { notes?: { id: string }[]; newIds?: string[] };
        return [...(input.notes ?? []).map((note) => note.id), ...(input.newIds ?? [])];
      });

    it("is refused back to the model in a step that is answered, and the gateway's counter goes on", async () => {
      const h = harness([toolUseEvents("Notes.", [firstAdd])], {}, [
        toolUseEvents("Again, and more.", [duplicateAt([`evt_${stem}n003`]), secondAdd]),
        toolUseEvents("Fixed.", [duplicateAt([`evt_${stem}0001`]), explainCall]),
      ]);
      const result = await turn(h);
      const answers = JSON.stringify(h.provider.requests[2].messages.at(-1));
      expect(answers).toContain(
        `evt_${stem}n003: a note ID with \\"n\\" before its number`,
      );
      expect(answers).toContain("4-digit number");
      expect(answers).toContain(`Its note's ID is evt_${stem}n003.`);
      expect(noteIdsOf(result)).toEqual([
        `evt_${stem}n001`,
        `evt_${stem}n002`,
        `evt_${stem}n003`,
        `evt_${stem}0001`,
      ]);
      expect(validateProposal(project, result.proposal).ok).toBe(true);
    });

    it("is skipped when the gateway numbers the last step's notes, which nothing answers", async () => {
      const h = harness([toolUseEvents("Notes.", [firstAdd])], {}, [
        toolUseEvents("Again, and more.", [
          secondAdd,
          duplicateAt([`evt_${stem}n003`]),
          explainCall,
        ]),
      ]);
      const result = await turn(h);
      expect(noteIdsOf(result)).toEqual([
        `evt_${stem}n001`,
        `evt_${stem}n002`,
        `evt_${stem}n004`,
        `evt_${stem}n003`,
      ]);
      expect(validateProposal(project, result.proposal).ok).toBe(true);
    });

    it("refuses the proposal with why, when the last step reuses one already given", async () => {
      const h = harness([toolUseEvents("Notes.", [firstAdd])], {}, [
        toolUseEvents("Again.", [duplicateAt([`evt_${stem}n002`]), explainCall]),
      ]);
      const validation = validateProposal(project, (await turn(h)).proposal);
      expect(validation).toMatchObject({
        ok: false,
        issues: [
          {
            code: "invalid_payload",
            message: `evt_${stem}n002: Groove has already given that ID to a note you wrote`,
          },
        ],
      });
    });
  });

  it("refuses the proposal with why a note in the last step is not one", async () => {
    const bad = {
      name: "note_add",
      input: { clipId: noteClip.id, notes: [[0, 400, 96, 0.8]] },
    };
    const h = harness([toolUseEvents("A note.", [bad, explainCall])]);
    const result = await run(h);
    expect(validateProposal(project, result.proposal)).toMatchObject({
      ok: false,
      issues: [
        { code: "invalid_payload", message: expect.stringMatching(/^notes\.0\.1:/) },
      ],
    });
  });

  it("refuses a malformed note back to the model, which sends it again", async () => {
    const bad = {
      name: "note_add",
      input: { clipId: noteClip.id, notes: [[0, 400, 96, 0.8]] },
    };
    const good = {
      name: "note_add",
      input: { clipId: noteClip.id, notes: [[0, 40, 96, 0.8]] },
    };
    const h = harness([toolUseEvents("A note.", [bad])], {}, [
      toolUseEvents("Fixed.", [good, explainCall]),
    ]);
    const result = await run(h);
    const answers = h.provider.requests[1].messages.at(-1);
    expect(JSON.stringify(answers)).toContain("notes.0.1:");
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      "note_add",
      EXPLAIN_TOOL_NAME,
    ]);
    expect(validateProposal(project, result.proposal).ok).toBe(true);
  });

  it("writes out the notes in an ask's previews too, in a counter of their own, so the producer can hear them", async () => {
    const stem = "Stem0000000000000";
    const proposed = {
      name: "note_add",
      input: { clipId: noteClip.id, notes: [[0, 40, 96, 0.8]] },
    };
    const previewClip = {
      name: "clip_create",
      input: {
        id: "clp_Stem00000000000000001",
        trackId: noteClip.trackId,
        name: "Answer",
        color: "#808080",
        lengthTicks: 768,
        content: {
          kind: "notes",
          events: [
            [0, 43, 192, 0.7],
            [384, 45, 192, 0.6],
          ],
        },
      },
    };
    const previewAdd = {
      name: "note_add",
      input: { clipId: noteClip.id, notes: [[192, 47, 96, 0.8]] },
    };
    const notANote = {
      name: "note_add",
      input: { clipId: noteClip.id, notes: [[192, 47]] },
    };
    const ask = {
      name: ASK_PRODUCER_TOOL_NAME,
      input: {
        question: "Which answer?",
        options: [
          {
            label: "A call and response",
            sound: { kind: "preview", calls: [previewClip, previewAdd] },
          },
          { label: "A half note", sound: { kind: "preview", calls: [notANote] } },
        ],
      },
    };
    const h = harness([toolUseEvents("A note and a question.", [proposed, ask])]);
    const result = await runAssistantTurn(
      { ...h.deps, idStem: () => stem },
      SIGNED_IN,
      request(),
      { signal: new AbortController().signal, onChunk: () => {} },
    );
    const [heard, broken] = (result.ask?.options ?? []).map(
      (option) => option.sound as Extract<AskSound, { kind: "preview" }>,
    );
    const commands = previewCommands(project, heard);
    expect(commands?.map((command) => command.type)).toEqual(["clip.create", "note.add"]);
    // Numbered apart from the proposal's notes, and unique within the preview.
    expect(JSON.stringify(result.proposal?.calls)).toContain("evt_Stem0000000000000n001");
    const previewIds = JSON.stringify(commands).match(/evt_Stem\w+/g);
    expect(previewIds).toEqual([
      "evt_Stem0000000000000p001",
      "evt_Stem0000000000000p002",
      "evt_Stem0000000000000p003",
    ]);
    // A preview whose notes are not notes is refused, as any bad call is.
    expect(broken.calls).toEqual([notANote]);
    expect(previewCommands(project, broken)).toBeNull();
  });
});

describe("runAssistantTurn: where a recommendation is aimed (GRV-129)", () => {
  // A kit of BD, SD and HH: its track and pads are in the context.
  const project = createDenseStepFixtureProject();
  const [kit] = project.song.tracks;
  if (kit?.instrument?.kind !== "drumMachine") throw new Error("not a kit");
  const [bdPad] = kit.instrument.pads;
  const kitRequest = (overrides: Partial<AssistantTurnRequest> = {}) =>
    request({
      projectRevision: project.metadata.revision,
      context: buildAssistantPayload(project),
      library: buildAssistantLibrary(),
      ...overrides,
    });
  const recommend = (target: { trackId?: string; padId?: string }) => ({
    name: RECOMMEND_SOUNDS_TOOL,
    input: {
      packId: "pak_drums00000000000000",
      soundIds: ["snare-dusty"],
      reason: "A snare for the backbeat.",
      ...target,
    },
  });
  const explainCall = {
    name: EXPLAIN_TOOL_NAME,
    input: { goal: "A backbeat", technique: "A snare on 2 and 4" },
  };
  const newKit = {
    ...CREATE_EXAMPLES.track,
    id: "trk_SnareHat0000000000001",
    name: "Snare & Hat",
    instrument: {
      kind: "drumMachine",
      parameters: {},
      pads: [
        {
          id: "pad_Snare0000000000000001",
          name: "Snare",
          assetId: null,
          chokeGroup: null,
          parameters: {},
          mixer: { volume: 0, pan: 0, muted: false, soloed: false },
        },
      ],
    },
  };
  const createKit = { name: "track_create", input: newKit };

  it("refuses a recommendation for a track neither the project nor the turn has, and keeps the corrected one", async () => {
    const h = harness(
      [
        toolUseEvents("A snare.", [
          recommend({ trackId: "trk_Nowhere00000000000001" }),
          explainCall,
        ]),
      ],
      {},
      [toolUseEvents("Fixed.", [recommend({ trackId: kit.id, padId: bdPad?.id })])],
    );
    const result = await run(h, kitRequest());
    expect(h.provider.requests).toHaveLength(2);
    const answers = h.provider.requests[1].messages.at(-1);
    expect(answers?.content).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_1", is_error: true }),
      expect.objectContaining({ tool_use_id: "toolu_2", content: "Noted." }),
    ]);
    expect(JSON.stringify(answers?.content)).toContain("trk_Nowhere00000000000001");
    const recommended = result.proposal?.calls.filter(
      (entry) => entry.name === RECOMMEND_SOUNDS_TOOL,
    );
    expect(recommended?.map((entry) => entry.input)).toEqual([
      recommend({ trackId: kit.id, padId: bdPad?.id }).input,
    ]);
  });

  it("refuses a pad the named track does not have", async () => {
    const h = harness(
      [
        toolUseEvents("A snare.", [
          recommend({ trackId: kit.id, padId: "pad_Nowhere00000000000001" }),
          explainCall,
        ]),
      ],
      {},
      [toolUseEvents("Fixed.", [recommend({ trackId: kit.id, padId: bdPad?.id })])],
    );
    await run(h, kitRequest());
    expect(h.provider.requests).toHaveLength(2);
    expect(h.provider.requests[1].messages.at(-1)?.content).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_1", is_error: true }),
      expect.objectContaining({ tool_use_id: "toolu_2" }),
    ]);
  });

  it("accepts a pad a track_create made earlier in the same turn, in one step", async () => {
    const aimed = recommend({ trackId: newKit.id, padId: "pad_Snare0000000000000001" });
    const h = harness([toolUseEvents("A snare.", [createKit, aimed, explainCall])]);
    const result = await run(h, kitRequest());
    expect(h.provider.requests).toHaveLength(1);
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      "track_create",
      RECOMMEND_SOUNDS_TOOL,
      EXPLAIN_TOOL_NAME,
    ]);
  });

  it("accepts a pad a track_create made in an earlier step", async () => {
    const aimed = recommend({ trackId: newKit.id, padId: "pad_Snare0000000000000001" });
    const h = harness([toolUseEvents("A kit.", [createKit])], {}, [
      toolUseEvents("A snare.", [aimed, explainCall]),
    ]);
    const result = await run(h, kitRequest());
    expect(h.provider.requests).toHaveLength(2);
    expect(h.provider.requests[1].messages.at(-1)?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: ADDED_RESULT },
    ]);
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      "track_create",
      RECOMMEND_SOUNDS_TOOL,
      EXPLAIN_TOOL_NAME,
    ]);
  });

  it("refuses a recommendation aimed at a track created only later in the turn", async () => {
    const aimed = recommend({ trackId: newKit.id, padId: "pad_Snare0000000000000001" });
    const h = harness([toolUseEvents("A snare.", [aimed, createKit])], {}, [
      toolUseEvents("Again.", [aimed, explainCall]),
    ]);
    await run(h, kitRequest());
    expect(h.provider.requests[1].messages.at(-1)?.content).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_1", is_error: true }),
      { type: "tool_result", tool_use_id: "toolu_2", content: ADDED_RESULT },
    ]);
  });

  it("lets a recommendation that names no track or pad through: it is for the selection", async () => {
    const h = harness([toolUseEvents("A snare.", [recommend({}), explainCall])]);
    const result = await run(h, kitRequest());
    expect(h.provider.requests).toHaveLength(1);
    expect(result.proposal?.calls).toHaveLength(2);
  });
});

describe("runAssistantTurn: a proposal in one response (GRV-142)", () => {
  const project = createReferenceProject();
  const [track] = project.song.tracks;
  const noteClip = project.clips.find((clip) => clip.content.kind === "notes");
  if (!noteClip) throw new Error("the reference project has a note clip");
  const stem = "Stem0000000000000";
  const muteCall = call(setTrackFlag(track.id, "muted", !track.mixer.muted));
  const soloCall = call(setTrackFlag(track.id, "soloed", !track.mixer.soloed));
  const volumeCall = call(
    setParameter({ scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id }, -9),
  );
  /** A call that does not fit its tool: track_set_flag with no track or value. */
  const badCall = { name: muteCall.name, input: { flag: "muted" } };
  const explainCall = {
    name: EXPLAIN_TOOL_NAME,
    input: { goal: "A tighter track", technique: "Set it up in one go" },
  };
  const addCall = (notes: unknown[]) => ({
    name: "note_add",
    input: { clipId: noteClip.id, notes },
  });

  function turn(h: Harness, oneResponseProposal: "on" | "off" = "on") {
    return runAssistantTurn(
      { ...h.deps, idStem: () => stem, tactics: { oneResponseProposal } },
      SIGNED_IN,
      request(),
      { signal: new AbortController().signal, onChunk: (chunk) => h.chunks.push(chunk) },
    );
  }
  const names = (result: AssistantTurnResult) =>
    result.proposal?.calls.map((entry) => entry.name);
  /** The answers the model was sent before its `index`th request, from 0. */
  const answersBefore = (h: Harness, index: number) =>
    h.provider.requests[index].messages.at(-1)?.content as unknown as {
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }[];

  it("asks for the whole proposal in one response, and production's prompt is unchanged", async () => {
    const on = harness([toolUseEvents("Done.", [muteCall, explainCall])]);
    await turn(on, "on");
    const prompt = on.provider.requests[0].system[0].text;
    expect(prompt).toBe(assistantSystemPrompt({ oneResponseProposal: "on" }));
    expect(prompt).toContain("Write the whole proposal in one response");
    expect(prompt).not.toContain("each step starts with one short sentence");
    const off = harness([toolUseEvents("Done.", [muteCall, explainCall])]);
    await turn(off, "off");
    expect(off.provider.requests[0].system[0].text).toBe(
      assistantSystemPrompt({ oneResponseProposal: "off" }),
    );
  });

  it("applies several calls in one step in order, numbering their notes in call order", async () => {
    const script = () => [
      toolUseEvents("A fuller part, quieter, muted.", [
        addCall([[0, 40, 96, 0.8]]),
        volumeCall,
        addCall([
          [96, 43, 96, 0.7],
          [192, 45, 96, 0.6],
        ]),
        muteCall,
        explainCall,
      ]),
    ];
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const h = harness(script());
      results.push(await turn(h));
      expect(h.provider.requests).toHaveLength(1);
    }
    const [result, again] = results;
    expect(names(result)).toEqual([
      "note_add",
      volumeCall.name,
      "note_add",
      muteCall.name,
      EXPLAIN_TOOL_NAME,
    ]);
    const noteIds = (result.proposal?.calls ?? []).flatMap(
      (entry) =>
        (entry.input as { notes?: { id: string }[] }).notes?.map((n) => n.id) ?? [],
    );
    expect(noteIds).toEqual([`evt_${stem}n001`, `evt_${stem}n002`, `evt_${stem}n003`]);
    // The same calls always expand to the same proposal.
    expect(again.proposal).toEqual(result.proposal);
    expect(validateProposal(project, result.proposal).ok).toBe(true);
  });

  it("refuses a bad call partway back to the model, keeping the calls around it", async () => {
    const h = harness(
      [toolUseEvents("Quieter and muted.", [volumeCall, badCall, explainCall])],
      {},
      [toolUseEvents("Fixed.", [muteCall])],
    );
    const result = await turn(h);
    // The fix explains nothing, so the turn asks once more, and it ends.
    expect(h.provider.requests).toHaveLength(3);
    const answers = answersBefore(h, 1);
    expect(answers[0]).not.toHaveProperty("is_error");
    expect(answers[1]).toMatchObject({ is_error: true });
    expect(answers[1].content).toContain("Refused, not added to the proposal");
    expect(names(result)).toEqual([volumeCall.name, EXPLAIN_TOOL_NAME, muteCall.name]);
    expect(validateProposal(project, result.proposal).ok).toBe(true);

    // Off, the step that explains ends the turn, and the browser refuses it.
    const off = harness([
      toolUseEvents("Quieter and muted.", [volumeCall, badCall, explainCall]),
    ]);
    await turn(off, "off");
    expect(off.provider.requests).toHaveLength(1);
  });

  it("refuses a third step of change calls, telling the model to finish with what it has", async () => {
    const h = harness([toolUseEvents("Muting it, continuing.", [muteCall])], {}, [
      toolUseEvents("Then its volume, continuing.", [volumeCall]),
      toolUseEvents("And solo it.", [soloCall]),
      toolUseEvents("Done.", [explainCall]),
    ]);
    const result = await turn(h);
    expect(h.provider.requests).toHaveLength(4);
    expect(answersBefore(h, 3)).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: CHANGE_STEPS_SPENT,
        is_error: true,
      },
    ]);
    expect(names(result)).toEqual([muteCall.name, volumeCall.name, EXPLAIN_TOOL_NAME]);

    // Off, a turn takes as many steps of changes as it needs.
    const off = harness([toolUseEvents("Muting it.", [muteCall])], {}, [
      toolUseEvents("Then its volume.", [volumeCall]),
      toolUseEvents("And solo it.", [soloCall]),
      toolUseEvents("Done.", [explainCall]),
    ]);
    expect(names(await turn(off, "off"))).toEqual([
      muteCall.name,
      volumeCall.name,
      soloCall.name,
      EXPLAIN_TOOL_NAME,
    ]);
  });

  it("refuses a change past the limit again, and leaves it out on the last step allowed", async () => {
    const h = harness([toolUseEvents("Mute.", [muteCall])], { maxSteps: 4 }, [
      toolUseEvents("Volume.", [volumeCall]),
      toolUseEvents("Solo.", [soloCall]),
      toolUseEvents("Solo, really.", [soloCall, explainCall]),
    ]);
    const result = await turn(h);
    expect(h.provider.requests).toHaveLength(4);
    expect(names(result)).toEqual([muteCall.name, volumeCall.name, EXPLAIN_TOOL_NAME]);
  });

  it("does not count a step fixing refused calls towards the limit", async () => {
    const h = harness(
      [toolUseEvents("Mute and set its volume.", [muteCall, badCall])],
      {},
      [
        toolUseEvents("Fixed.", [soloCall]),
        toolUseEvents("And its volume, the second part.", [volumeCall]),
        toolUseEvents("Done.", [explainCall]),
      ],
    );
    const result = await turn(h);
    expect(h.provider.requests).toHaveLength(4);
    expect(answersBefore(h, 3).some((answer) => answer.is_error)).toBe(false);
    expect(names(result)).toEqual([
      muteCall.name,
      soloCall.name,
      volumeCall.name,
      EXPLAIN_TOOL_NAME,
    ]);
  });
});

describe("runAssistantTurn: tool bundles (GRV-143)", () => {
  const project = createReferenceProject();
  const [track] = project.song.tracks;
  const muteCall = call(setTrackFlag(track.id, "muted", !track.mixer.muted));
  const explainCall = {
    name: EXPLAIN_TOOL_NAME,
    input: { goal: "The track drops out.", technique: "Muting takes it out of the mix." },
  };
  const needMore = { name: NEED_MORE_TOOLS_NAME, input: {} };
  const ALWAYS = [EXPLAIN_TOOL_NAME, ASK_PRODUCER_TOOL_NAME];
  const EVERY_TOOL = [...assistantTools().map((tool) => tool.name), ...ALWAYS];

  function bundled(h: Harness): Harness {
    h.deps = { ...h.deps, tactics: { toolBundles: "bundled" } };
    return h;
  }

  const asking = (text: string) => request({ messages: [{ role: "user", text }] });
  const names = (h: Harness, index: number) =>
    h.provider.requests[index]?.tools.map((tool) => tool.name);

  it("offers every tool and no need_more_tools under all, production's default", async () => {
    const h = harness([replyEvents(["Sure."])]);
    await run(h, asking("Make the kick louder"));
    expect(names(h, 0)).toEqual(EVERY_TOOL);
    expect(h.logs[0]).toMatchObject({ toolBundle: null, toolBundleFallback: null });
  });

  it("offers the bundle the rule picks, need_more_tools after the tools every bundle has", async () => {
    const h = bundled(harness([replyEvents(["Sure."])]));
    await run(h, asking("Make the kick louder"));
    expect(names(h, 0)).toEqual([
      ...bundleTools("mix").map((tool) => tool.name),
      ...ALWAYS,
      NEED_MORE_TOOLS_NAME,
    ]);
    expect(h.logs[0]).toMatchObject({ toolBundle: "mix", toolBundleFallback: null });
  });

  it("sends a bundle's tool block byte for byte the same whatever else the turn says", async () => {
    const first = bundled(harness([replyEvents(["Sure."])]));
    await run(first, asking("Make the kick louder"));
    const second = bundled(harness([replyEvents(["Sure."])]));
    await run(
      second,
      request({
        messages: [
          { role: "user", text: "Hi" },
          { role: "assistant", text: "Hello." },
          { role: "user", text: "Pan the hats left a bit" },
        ],
      }),
    );
    expect(second.logs[0]?.toolBundle).toBe("mix");
    expect(JSON.stringify(second.provider.requests[0]?.tools)).toBe(
      JSON.stringify(first.provider.requests[0]?.tools),
    );
  });

  it("sends the everything bundle exactly as all does, so the two share a cache entry", async () => {
    const all = harness([replyEvents(["Sure."])]);
    all.deps = { ...all.deps, idStem: () => "stem" };
    await run(all, asking("Make me a house beat"));
    const h = bundled(harness([replyEvents(["Sure."])]));
    h.deps = { ...h.deps, idStem: () => "stem" };
    await run(h, asking("Make me a house beat"));
    expect(h.logs[0]?.toolBundle).toBe("everything");
    expect(JSON.stringify(h.provider.requests[0])).toBe(
      JSON.stringify(all.provider.requests[0]),
    );
  });

  it("re-runs the step with every tool when the model calls need_more_tools", async () => {
    const h = bundled(
      harness([
        toolUseEvents("", [needMore]),
        toolUseEvents("Muting it.", [muteCall, explainCall]),
      ]),
    );
    const result = await run(h, asking("Quantize the notes"));
    expect(h.provider.requests).toHaveLength(2);
    expect(names(h, 0)).toContain(NEED_MORE_TOOLS_NAME);
    expect(names(h, 0)).not.toContain(muteCall.name);
    // The same step again: the same messages, every tool, no need_more_tools.
    expect(names(h, 1)).toEqual(EVERY_TOOL);
    expect(h.provider.requests[1]?.messages).toEqual(h.provider.requests[0]?.messages);
    expect(h.provider.requests[1]?.system).toEqual(h.provider.requests[0]?.system);
    // Its call is the gateway's, never the proposal's.
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      muteCall.name,
      EXPLAIN_TOOL_NAME,
    ]);
    expect(result.text).toBe("Muting it.");
    expect(h.logs[0]).toMatchObject({
      toolBundle: "notes",
      toolBundleFallback: "need_more_tools",
      attempts: 2,
    });
  });

  it("does not count the re-run as one of the turn's steps", async () => {
    const h = bundled(
      harness(
        [toolUseEvents("", [needMore]), toolUseEvents("", [muteCall])],
        { maxSteps: 2 },
        [toolUseEvents("Done.", [explainCall])],
      ),
    );
    const result = await run(h, asking("Quantize the notes"));
    expect(h.provider.requests).toHaveLength(3);
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      muteCall.name,
      EXPLAIN_TOOL_NAME,
    ]);
  });

  it("takes a call to a tool the bundle did not offer, and offers every tool from then on", async () => {
    const h = bundled(
      harness([toolUseEvents("Muting it.", [muteCall])], {}, [
        toolUseEvents("Done.", [explainCall]),
      ]),
    );
    const result = await run(h, asking("Quantize the notes"));
    expect(names(h, 0)).not.toContain(muteCall.name);
    expect(names(h, 1)).toEqual(EVERY_TOOL);
    expect(result.proposal?.calls.map((entry) => entry.name)).toEqual([
      muteCall.name,
      EXPLAIN_TOOL_NAME,
    ]);
    expect(h.logs[0]).toMatchObject({
      toolBundle: "notes",
      toolBundleFallback: "unoffered_tool",
    });
  });
});
