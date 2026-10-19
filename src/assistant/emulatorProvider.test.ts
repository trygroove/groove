import { describe, expect, it } from "vitest";
import { executeTransaction } from "../commands/execute";
import type { Project } from "../domain/entities";
import {
  createDenseStepFixtureProject,
  createReferenceProject,
  createSliceFixtureProject,
} from "../domain/fixtures";
import { SONG_SWING } from "../domain/parameters";
import { createStarterProject } from "../editor/starterProject";
import { lessonCue } from "../lessons/cue";
import { skip, startBite } from "../lessons/session";
import { buildAssistantLibrary, DRUM_PACK_ID } from "../testing/assistantLibrary";
import { starterWorld } from "../testing/lessonWorld";
import {
  createEmulatorAssistantProvider,
  DUSTIER_ROLE,
  EMULATOR_ASK,
  EMULATOR_MISSING_VIDEO_QUERY,
  EMULATOR_REMEMBER,
  EMULATOR_REPLY_CHUNKS,
  EMULATOR_VIDEO,
  emulatorVideoFinder,
  FIRST_BEAT,
  LOOSEN_EXPLANATION,
  LOOSEN_SWING,
  LOOSEN_VOLUME_DROP_DB,
  lessonReplyText,
  MISFIT_ASSET_ID,
  usesEmulatorProvider,
} from "./emulatorProvider";
import { type AssistantGatewayDeps, runAssistantTurn } from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import type { AssistantLessonContext } from "./lesson";
import { START_LESSON_TOOL_NAME } from "./lessonTool";
import { type AssistantMemoryContext, REMEMBER_TOOL_NAME } from "./memory";
import { buildAssistantPayload } from "./payload";
import { validateProposal } from "./proposal";
import type { AssistantLibraryContext } from "./protocol";
import {
  AssistantGatewayError,
  type AssistantStreamChunk,
  type AssistantTurnResult,
} from "./protocol";
import { splitRecommendations, validateRecommendation } from "./recommendation";

/** The emulator's provider, behind the real gateway, as the function runs it. */
function gateway(): AssistantGatewayDeps {
  return {
    provider: createEmulatorAssistantProvider(),
    guards: createInMemoryGuardStores(),
    log: () => {},
    now: () => 1_000,
    sleep: async () => {},
  };
}

function turn(
  deps: AssistantGatewayDeps,
  text: string,
  signal: AbortSignal = new AbortController().signal,
  project: Project = createReferenceProject(),
  library?: AssistantLibraryContext,
  memory?: AssistantMemoryContext,
): { chunks: AssistantStreamChunk[]; result: Promise<AssistantTurnResult> } {
  const chunks: AssistantStreamChunk[] = [];
  const result = runAssistantTurn(
    deps,
    { uid: "uid-1", signInProvider: "google.com" },
    {
      projectRevision: project.metadata.revision,
      messages: [{ role: "user", text }],
      context: buildAssistantPayload(project),
      ...(library ? { library } : {}),
      ...(memory ? { memory } : {}),
    },
    { signal, onChunk: (chunk) => chunks.push(chunk) },
  );
  return { chunks, result };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AssistantGatewayError) return error.code;
    throw error;
  }
  return "completed";
}

describe("the emulator's assistant provider", () => {
  it("streams its reply in pieces and completes the turn", async () => {
    const { chunks, result } = turn(gateway(), "Make it groove");
    const reply = await result;
    expect(chunks.map((chunk) => chunk.text)).toEqual([...EMULATOR_REPLY_CHUNKS]);
    expect(reply.text).toBe(EMULATOR_REPLY_CHUNKS.join(""));
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.proposal).toBeNull();
  });

  it("hangs on [hang] until the turn is stopped, which cancels it", async () => {
    const controller = new AbortController();
    const { chunks, result } = turn(gateway(), "Keep going [hang]", controller.signal);
    await expect.poll(() => chunks.length).toBe(1);
    controller.abort();
    expect(await codeOf(result)).toBe("cancelled");
  });

  it("fails [flaky] once as a retryable provider failure, then answers", async () => {
    const deps = gateway();
    const first = turn(deps, "Again [flaky] 1");
    expect(await codeOf(first.result)).toBe("provider_unavailable");
    expect(first.chunks).toHaveLength(1);
    const second = turn(deps, "Again [flaky] 1");
    expect((await second.result).text).toBe(EMULATOR_REPLY_CHUNKS.join(""));
  });

  it("asks the memory it is given whether [flaky] failed before", async () => {
    const asked: string[] = [];
    const deps = {
      ...gateway(),
      provider: createEmulatorAssistantProvider((message) => {
        asked.push(message);
        return false;
      }),
    };
    // Another worker already failed this message: this one answers.
    const reply = await turn(deps, "Again [flaky] 2").result;
    expect(reply.text).toBe(EMULATOR_REPLY_CHUNKS.join(""));
    expect(asked).toEqual(["Again [flaky] 2"]);
  });

  it("ends [propose] in a proposal the browser accepts", async () => {
    const reply = await turn(gateway(), "Change it [propose]").result;
    expect(reply.stopReason).toBe("tool_use");
    expect(reply.proposal?.calls).toHaveLength(1);
    const validation = validateProposal(createReferenceProject(), reply.proposal);
    expect(validation.ok).toBe(true);
  });

  it("ends [misfit] in a proposal the browser rejects: a sound the song does not have (GRV-98)", async () => {
    for (const project of [createReferenceProject(), createSliceFixtureProject()]) {
      const reply = await turn(
        gateway(),
        "Add a noisy layer [misfit]",
        new AbortController().signal,
        project,
      ).result;
      expect(reply.stopReason).toBe("tool_use");
      const validation = validateProposal(project, reply.proposal);
      expect(validation.ok ? null : validation.issues).toEqual([
        expect.objectContaining({
          code: "invalid_project",
          callIndex: 0,
          path: expect.stringMatching(/instrument\.assetId$/),
          message: expect.stringContaining(MISFIT_ASSET_ID),
        }),
      ]);
    }
  });

  it("answers CF-027's 'Loosen the beat' with swing and a quieter track", async () => {
    const project = createSliceFixtureProject();
    const track = project.song.tracks.find((candidate) => candidate.name === "BD");
    if (!track) throw new Error("the fixture has no BD");
    const signal = new AbortController().signal;
    const reply = await turn(gateway(), "Loosen the beat", signal, project).result;
    expect(reply.stopReason).toBe("tool_use");
    const validation = validateProposal(project, reply.proposal);
    if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
    expect(validation.proposal.commands).toHaveLength(2);
    const applied = executeTransaction(project, validation.proposal.commands, {
      actor: "assistant",
    });
    if (!applied.ok) throw new Error("the proposal did not apply");
    expect(applied.project.song.swing).toBe(LOOSEN_SWING);
    expect(LOOSEN_SWING).toBeGreaterThan(SONG_SWING.defaultValue);
    const after = applied.project.song.tracks.find(
      (candidate) => candidate.id === track.id,
    );
    expect(after?.mixer.volume).toBe(track.mixer.volume - LOOSEN_VOLUME_DROP_DB);
    expect(validation.proposal.explanation).toEqual(LOOSEN_EXPLANATION);
  });

  it("ends [ask] in a question for the producer, and [ask-multi] in a multi-select", async () => {
    const single = await turn(gateway(), "Help [ask]").result;
    expect(single.stopReason).toBe("tool_use");
    expect(single.proposal).toBeNull();
    expect(single.ask).toEqual({ id: "toolu_ask", ...EMULATOR_ASK, multiSelect: false });
    const multi = await turn(gateway(), "Help [ask-multi]").result;
    expect(multi.ask?.multiSelect).toBe(true);
  });

  it("ends [remember] in a memory proposal on a turn that carries memory (GRV-25)", async () => {
    const memory: AssistantMemoryContext = {
      taste: [],
      artists: "",
      experience: null,
      goal: null,
      learn: [],
      gear: [],
      notes: [],
      askLater: null,
    };
    const reply = await turn(
      gateway(),
      "I'm making more trap lately [remember]",
      new AbortController().signal,
      createReferenceProject(),
      undefined,
      memory,
    ).result;
    expect(reply.stopReason).toBe("tool_use");
    expect(reply.proposal?.calls).toEqual([
      expect.objectContaining({ name: REMEMBER_TOOL_NAME, input: EMULATOR_REMEMBER }),
    ]);
  });

  it("ends [lesson] in start_lesson on a turn that carries memory (GRV-43)", async () => {
    const memory: AssistantMemoryContext = {
      taste: [],
      artists: "",
      experience: null,
      goal: null,
      learn: [],
      gear: [],
      notes: [],
      askLater: null,
    };
    const reply = await turn(
      gateway(),
      "Teach me to make a beat [lesson]",
      new AbortController().signal,
      createReferenceProject(),
      undefined,
      memory,
    ).result;
    expect(reply.proposal?.calls).toEqual([
      expect.objectContaining({
        name: START_LESSON_TOOL_NAME,
        input: { chapter: "beat" },
      }),
    ]);
  });

  it("answers a lesson's turn naming its bite, or the chapter at its end (CF-037)", async () => {
    const world = starterWorld();
    const settings = { style: "boom_bap" } as const;
    const started = startBite("beat", "beat-kick", world, settings);
    const startedCue = lessonCue(started.state, started.event, settings, []);
    const project = createStarterProject("owner-1", () => 0.5);
    const answer = (lesson: AssistantLessonContext) =>
      runAssistantTurn(
        gateway(),
        { uid: "uid-1", signInProvider: "google.com" },
        {
          projectRevision: project.metadata.revision,
          messages: [{ role: "user", text: 'Let\'s do "The kick pattern".' }],
          context: buildAssistantPayload(project),
          lesson,
        },
        { signal: new AbortController().signal, onChunk: () => {} },
      );
    expect((await answer(startedCue)).text).toBe(lessonReplyText(startedCue));
    expect(lessonReplyText(startedCue)).toContain('"The kick pattern"');

    const last = startBite("beat", "beat-loop", world, settings).state;
    const over = skip(last, world, settings);
    if (!over) throw new Error("not skipped");
    const wrapUp = lessonCue(over.state, over.event, settings, []);
    expect((await answer(wrapUp)).text).toContain('"Make a beat" finished');
    // A message the producer wrote mid-lesson is answered as any other.
    expect((await answer({ ...startedCue, moment: "under_way" })).text).toBe(
      EMULATOR_REPLY_CHUNKS.join(""),
    );
  });

  it("ends [ask-rich] in a question about the project's first track, with a preview that applies", async () => {
    const project = createReferenceProject();
    const reply = await turn(gateway(), "Where do I start? [ask-rich]").result;
    const options = reply.ask?.options ?? [];
    expect(options.map((option) => option.label)).toEqual([
      "The first track",
      "The opening",
      "Slower, at 100 BPM",
    ]);
    expect(options[0]?.ref).toEqual({
      kind: "track",
      trackId: project.song.tracks[0]?.id,
    });
    const preview = options[2]?.sound;
    if (preview?.kind !== "preview") throw new Error("the third option has no preview");
    const validation = validateProposal(project, {
      baseRevision: project.metadata.revision,
      calls: preview.calls,
    });
    expect(validation.ok).toBe(true);
    expect(options[2]?.doneWhen).toEqual({ kind: "tempo", max: 100 });
  });

  it("answers CF-034's 'anything dustier?' with unused kicks, dustiest first", async () => {
    const project = createSliceFixtureProject();
    const bd = project.song.tracks.find((candidate) => candidate.name === "BD");
    const library = buildAssistantLibrary();
    const signal = new AbortController().signal;
    const reply = await turn(
      gateway(),
      "The kick is too clean. Anything dustier?",
      signal,
      project,
      library,
    ).result;
    expect(reply.stopReason).toBe("tool_use");
    if (!reply.proposal) throw new Error("no recommendation");
    const split = splitRecommendations(reply.proposal);
    expect(split.proposal).toBeNull();
    expect(split.recommendations).toHaveLength(1);
    const validation = validateRecommendation(split.recommendations[0].input, library);
    if (!validation.ok) throw new Error(validation.message);
    const { pack, sounds, trackId } = validation.recommendation;
    expect(pack.id).toBe(DRUM_PACK_ID);
    // The one the project uses is left out; the grittiest comes first.
    expect(sounds.map((sound) => sound.name)).toEqual([
      "Dusty Kick",
      "Warm Kick",
      "Tight Kick",
    ]);
    expect(sounds.every((sound) => sound.role === DUSTIER_ROLE)).toBe(true);
    expect(trackId).toBe(bd?.id);
  });

  it("names the kick's pad on a drum machine, not whichever is selected", async () => {
    // A kit of BD, SD and HH: the kick is for BD, whatever the producer last touched.
    const project = createDenseStepFixtureProject();
    const drums = project.song.tracks[0];
    if (drums.instrument?.kind !== "drumMachine") throw new Error("not a kit");
    const bd = drums.instrument.pads.find((pad) => pad.name === "BD");
    const library = buildAssistantLibrary();
    const reply = await turn(
      gateway(),
      "The kick is too clean. Anything dustier?",
      new AbortController().signal,
      project,
      library,
    ).result;
    if (!reply.proposal) throw new Error("no recommendation");
    const [call] = splitRecommendations(reply.proposal).recommendations;
    const validation = validateRecommendation(call.input, library);
    if (!validation.ok) throw new Error(validation.message);
    expect(validation.recommendation.trackId).toBe(drums.id);
    expect(validation.recommendation.padId).toBe(bd?.id);
  });

  it("names no pad on a sampler track", async () => {
    const library = buildAssistantLibrary();
    const reply = await turn(
      gateway(),
      "Anything dustier?",
      new AbortController().signal,
      createSliceFixtureProject(),
      library,
    ).result;
    if (!reply.proposal) throw new Error("no recommendation");
    const [call] = splitRecommendations(reply.proposal).recommendations;
    const validation = validateRecommendation(call.input, library);
    if (!validation.ok) throw new Error(validation.message);
    expect(validation.recommendation.padId).toBeNull();
  });

  it("answers [first-beat] with a new drum machine, then a kick, a snare and a hat for their own pads (CF-036)", async () => {
    const project = createStarterProject("uid-1", () => 0);
    const bd = project.song.tracks[0];
    if (bd?.instrument?.kind !== "drumMachine") throw new Error("no starter kit");
    const library = buildAssistantLibrary();
    const reply = await turn(
      gateway(),
      "Let's go [first-beat]",
      new AbortController().signal,
      project,
      library,
    ).result;
    if (!reply.proposal) throw new Error("no proposal");
    const split = splitRecommendations(reply.proposal);
    if (!split.proposal) throw new Error("no changes proposed");
    // The changes fit the starter project, and add the track and its clip.
    const validation = validateProposal(project, split.proposal);
    if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
    const applied = executeTransaction(project, validation.proposal.commands);
    if (!applied.ok) throw new Error("the proposal did not apply");
    const kit = applied.project.song.tracks.find(
      (track) => track.id === FIRST_BEAT.trackId,
    );
    expect(kit?.name).toBe(FIRST_BEAT.trackName);
    if (kit?.instrument?.kind !== "drumMachine") throw new Error("no new kit");
    expect(kit.instrument.pads.map((pad) => [pad.id, pad.name, pad.assetId])).toEqual([
      [FIRST_BEAT.snarePadId, "Snare", null],
      [FIRST_BEAT.hatPadId, "Hat", null],
    ]);
    expect(
      applied.project.song.placements.some((placement) => placement.trackId === kit.id),
    ).toBe(true);
    // Kick, snare and hat, each for its own pad.
    const recommended = split.recommendations.map((call) => {
      const checked = validateRecommendation(call.input, library);
      if (!checked.ok) throw new Error(checked.message);
      const { sounds, trackId, padId } = checked.recommendation;
      return [sounds[0]?.role, trackId, padId];
    });
    expect(recommended).toEqual([
      ["kick", bd.id, bd.instrument.pads[0]?.id],
      ["snare", FIRST_BEAT.trackId, FIRST_BEAT.snarePadId],
      ["closed-hat", FIRST_BEAT.trackId, FIRST_BEAT.hatPadId],
    ]);
  });

  it("says it can't find one when the turn carries no library", async () => {
    const reply = await turn(gateway(), "Anything dusty?").result;
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.proposal).toBeNull();
    expect(reply.text).toMatch(/can't find/);
  });

  it("answers [video] with the one video its search finds (GRV-16)", async () => {
    const reply = await turn(
      { ...gateway(), findVideo: emulatorVideoFinder },
      "How do I get that acid squelch? [video]",
    ).result;
    expect(reply.text.length).toBeGreaterThan(0);
    expect(reply.proposal).toBeNull();
    const { query: _query, ...video } = EMULATOR_VIDEO;
    expect(reply.videos).toEqual([video]);
    expect(
      await emulatorVideoFinder(
        EMULATOR_MISSING_VIDEO_QUERY,
        new AbortController().signal,
      ),
    ).toBe("missing");
    // The search that found nothing is said to be left out, not left implied.
    expect(reply.text).toMatch(/left it out\.$/);
  });

  it("is only chosen in the emulator, and only with no key", () => {
    expect(usesEmulatorProvider({ FUNCTIONS_EMULATOR: "true" }, "")).toBe(true);
    expect(usesEmulatorProvider({ FUNCTIONS_EMULATOR: "true" }, "sk-real")).toBe(false);
    expect(usesEmulatorProvider({}, "")).toBe(false);
  });
});
