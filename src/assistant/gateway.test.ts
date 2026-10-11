import { describe, expect, it } from "vitest";
import {
  createCommandHistory,
  type RawCommandInput,
  setParameter,
  setTrackFlag,
} from "../commands";
import { createReferenceProject } from "../domain/fixtures";
import { TRACK_VOLUME } from "../domain/parameters";
import { buildAssistantLibrary } from "../testing/assistantLibrary";
import {
  type CallScript,
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../testing/scriptedAssistantProvider";
import { ASK_PRODUCER_TOOL_NAME } from "./ask";
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
import { buildAssistantPayload } from "./payload";
import { ASSISTANT_PROMPT_VERSION, LIBRARY_BLOCK_HEADING } from "./prompt";
import { validateProposal } from "./proposal";
import { createProposalExecutor } from "./proposalExecutor";
import {
  type AssistantErrorCode,
  AssistantGatewayError,
  type AssistantStreamChunk,
  type AssistantTurnRequest,
} from "./protocol";
import { RECOMMEND_SOUNDS_TOOL } from "./recommendation";
import { type AssistantTurnLog, TURN_LOG_KEYS } from "./telemetry";
import {
  ASSISTANT_TOOLSET_VERSION,
  assistantTools,
  EXPLAIN_TOOL_NAME,
  toolNameFor,
} from "./tools";

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
): Harness {
  const provider = createScriptedAssistantProvider(scripts);
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

  it("returns a tool call with no input as an empty object", async () => {
    const events = toolUseEvents("Clearing it.", [{ name: "notes_clear", input: {} }]);
    const h = harness([
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
    ]);
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
    const h = harness([
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
    ]);
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
        { inactivityTimeoutMs: 40 },
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
