import { describe, expect, it } from "vitest";
import type { Clip, NoteEvent, Placement, Project, Track } from "../../domain/entities";
import {
  createFactoryContext,
  createNoteClip,
  createNoteEvent,
  createPlacement,
  createSynthInstrument,
  createTrack,
} from "../../domain/factories";
import { createSeededIdFactory, type PadId } from "../../domain/ids";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import {
  arrangementBars,
  CASE_CHECK_IDS,
  checkDevelopsTrack,
  checkDissonant,
  checkHatDensity,
  checkOutcome,
  checkPadSound,
  checkPointsToGenerate,
  checkRecommendationTargets,
  runCaseCheck,
} from "./caseChecks";
import { evalLibrary } from "./evalLibrary";
import { createTechnoDrumsProject, createTechnoLoopProject } from "./fixtures";

const context = (seed: string) =>
  createFactoryContext({ ids: createSeededIdFactory(seed) });

describe("check 8: expected outcome", () => {
  const ask = { question: "What kind of track is this?" };
  const proposal = { calls: [] };

  it("passes a question with no proposal when the case expects one", () => {
    expect(checkOutcome("ask", { proposal: null, ask }).status).toBe("pass");
  });

  it("fails a proposal, or a reply that neither asks nor proposes, when the case expects a question", () => {
    expect(checkOutcome("ask", { proposal, ask }).status).toBe("fail");
    expect(checkOutcome("ask", { proposal: null, ask: null })).toEqual({
      status: "fail",
      detail: "Neither asked a question nor proposed",
    });
  });

  it("passes a proposal and fails a turn that only asked when the case expects a proposal", () => {
    expect(checkOutcome("proposal", { proposal, ask: null }).status).toBe("pass");
    expect(checkOutcome("proposal", { proposal: null, ask })).toEqual({
      status: "fail",
      detail: 'Only asked "What kind of track is this?"',
    });
  });
});

describe("check 9: denser hats, nothing else", () => {
  const before = createTechnoDrumsProject();
  const [clip] = before.clips;
  const drums = before.song.tracks[0];
  if (clip.content.kind !== "notes" || drums.instrument?.kind !== "drumMachine") {
    throw new Error("unexpected fixture");
  }
  const events = clip.content.events;
  const pad = (name: string) => {
    const found =
      drums.instrument?.kind === "drumMachine" &&
      drums.instrument.pads.find((candidate) => candidate.name === name);
    if (!found) throw new Error(name);
    return found.id;
  };
  const closedHat = pad("Closed Hat");
  const kick = pad("Kick");
  const ctx = context("hat-density");
  const hatsAt = (padId: PadId, sixteenths: readonly number[]) =>
    sixteenths.map((step) =>
      createNoteEvent(ctx, {
        padId,
        startTicks: step * TICKS_PER_SIXTEENTH,
        durationTicks: TICKS_PER_SIXTEENTH,
      }),
    );
  const withEvents = (next: readonly NoteEvent[]): Project => ({
    ...before,
    clips: [{ ...clip, content: { kind: "notes", events: [...next] } }],
  });
  const hatPads = new Set([closedHat, pad("Open Hat")]);
  const hatCount = events.filter(
    (event) => event.trigger.kind === "pad" && hatPads.has(event.trigger.padId),
  ).length;

  it("passes hats at least half as many again, every other note as it was", () => {
    // Closed hats on every 16th that had none in the first bar: well over 1.5x.
    const extra = hatsAt(closedHat, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
    const result = checkHatDensity(before, withEvents([...events, ...extra]));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain(`${hatCount} hat notes became ${hatCount + 12}`);
  });

  it("passes a clip cleared and rewritten with new IDs", () => {
    const rewritten = events.map((event) => ({
      ...event,
      id: ctx.ids("event"),
    }));
    const extra = hatsAt(closedHat, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
    expect(checkHatDensity(before, withEvents([...rewritten, ...extra])).status).toBe(
      "pass",
    );
  });

  it("fails too few extra hats", () => {
    const result = checkHatDensity(
      before,
      withEvents([...events, ...hatsAt(closedHat, [1])]),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("needs 1.5x");
  });

  it("fails when another pad's notes change", () => {
    const extra = hatsAt(closedHat, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
    const result = checkHatDensity(
      before,
      withEvents([...events, ...extra, ...hatsAt(kick, [2])]),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("other than the hats");
  });

  it("fails when the clip is gone", () => {
    expect(checkHatDensity(before, { ...before, clips: [] }).status).toBe("fail");
  });

  it('does not take a pad whose name only contains "hat", like Chat, for a hat', () => {
    const instrument = drums.instrument;
    if (instrument?.kind !== "drumMachine") throw new Error("unexpected fixture");
    const renamed: Project = {
      ...before,
      song: {
        ...before.song,
        tracks: [
          {
            ...drums,
            instrument: {
              ...instrument,
              pads: instrument.pads.map((candidate) =>
                candidate.id === kick ? { ...candidate, name: "Chat" } : candidate,
              ),
            },
          },
          ...before.song.tracks.slice(1),
        ],
      },
    };
    const extra = hatsAt(closedHat, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
    const result = checkHatDensity(renamed, {
      ...withEvents([...events, ...extra, ...hatsAt(kick, [2])]),
      song: renamed.song,
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("other than the hats");
  });
});

describe("check 10: points to the Generate panel", () => {
  it.each([
    "Sure, here's a denser pattern. You can also generate patterns using the Random generator panel.",
    "Try the Generate panel under the step grid for more.",
    "The panel called Generate can roll more.",
  ])("passes %j", (text) => {
    expect(checkPointsToGenerate(text).status).toBe("pass");
  });

  it.each([
    "Sure, here's a denser pattern.",
    "I'll generate more hats, and the mixer panel is unchanged across all of the many other bars.",
  ])("fails %j", (text) => {
    expect(checkPointsToGenerate(text).status).toBe("fail");
  });
});

/** The techno loop rearranged: `bars` long, each track placed over `ranges` of bars. */
function arranged(
  before: Project,
  ranges: Readonly<Record<string, readonly (readonly [number, number])[]>>,
): Project {
  const ctx = context("arranged");
  const placements: Placement[] = before.song.tracks.flatMap((track) => {
    const clip = before.clips.find((candidate) => candidate.trackId === track.id) as Clip;
    return (ranges[track.name] ?? []).map(([start, end]) =>
      createPlacement(ctx, {
        clipId: clip.id,
        trackId: track.id,
        startTicks: start * TICKS_PER_BAR,
        durationTicks: (end - start) * TICKS_PER_BAR,
        looped: true,
      }),
    );
  });
  return { ...before, song: { ...before.song, placements } };
}

describe("check 11: develops the loop into a track", () => {
  const before = createTechnoLoopProject();

  it("passes 160 bars where each track drops out and three sets of tracks play", () => {
    const after = arranged(before, {
      Drums: [
        [0, 64],
        [96, 160],
      ],
      Synth: [[32, 128]],
    });
    expect(arrangementBars(after)).toBe(160);
    const result = checkDevelopsTrack(after);
    expect(result).toEqual({
      status: "pass",
      detail: "160 bars; every track drops out; 3 different sets of tracks",
    });
  });

  it("fails the 4-bar loop as it was", () => {
    const result = checkDevelopsTrack(before);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("4 bars long");
  });

  it("fails a track that never drops out and too few changes", () => {
    const after = arranged(before, {
      Drums: [[0, 160]],
      Synth: [[32, 160]],
    });
    const result = checkDevelopsTrack(after);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("never drops out: Drums");
    expect(result.detail).toContain("2 different sets of tracks play, needs 3");
  });

  it("does not count bars where nothing plays as a set of tracks", () => {
    // Both tracks, then silence, then drums only: two sets of tracks, not three.
    const after = arranged(before, {
      Drums: [
        [0, 64],
        [96, 160],
      ],
      Synth: [[0, 64]],
    });
    const result = checkDevelopsTrack(after);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("2 different sets of tracks play, needs 3");
  });

  it("fails one over 300 bars", () => {
    const after = arranged(before, {
      Drums: [
        [0, 64],
        [96, 320],
      ],
      Synth: [[32, 128]],
    });
    expect(checkDevelopsTrack(after).detail).toContain("320 bars long");
  });
});

interface PadOptions {
  readonly attack?: number;
  readonly release?: number;
  readonly bars?: number;
  /** Whether the clip is placed on the new track; it is unless this is false. */
  readonly placed?: boolean;
  /** Each chord: its pitches, all starting at the given bar. */
  readonly chords?: readonly (readonly [bar: number, pitches: readonly number[]])[];
}

/** The techno loop with one new synth track playing `chords`. */
function withPad(before: Project, options: PadOptions = {}): Project {
  const ctx = context("pad");
  const parameters: Record<string, number> = {};
  if (options.attack !== undefined) parameters.ampAttack = options.attack;
  if (options.release !== undefined) parameters.ampRelease = options.release;
  const track: Track = createTrack(ctx, {
    name: "Pad",
    order: before.song.tracks.length,
    instrument: { ...createSynthInstrument(), parameters },
  });
  const bars = options.bars ?? 4;
  const chords = options.chords ?? [
    [0, [69, 70, 76]],
    [2, [67, 72, 78]],
  ];
  const clip = createNoteClip(ctx, {
    trackId: track.id,
    name: "Pad",
    lengthTicks: bars * TICKS_PER_BAR,
    events: chords.flatMap(([bar, pitches]) =>
      pitches.map((pitch) =>
        createNoteEvent(ctx, {
          pitch,
          startTicks: bar * TICKS_PER_BAR,
          durationTicks: 2 * TICKS_PER_BAR,
        }),
      ),
    ),
  });
  const placements =
    options.placed === false
      ? before.song.placements
      : [
          ...before.song.placements,
          createPlacement(ctx, {
            clipId: clip.id,
            trackId: track.id,
            startTicks: 0,
            durationTicks: bars * TICKS_PER_BAR,
            looped: true,
          }),
        ];
  return {
    ...before,
    clips: [...before.clips, clip],
    song: { ...before.song, tracks: [...before.song.tracks, track], placements },
  };
}

describe("check 12: a sparse, slow pad", () => {
  const before = createTechnoLoopProject();

  it("passes one synth with a slow attack, a long release and a sparse 4-bar clip", () => {
    const result = checkPadSound(before, withPad(before, { attack: 1.5, release: 3 }));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("attack 1.5 s, release 3 s");
  });

  it("fails the synth's default, snappy envelope", () => {
    const result = checkPadSound(before, withPad(before));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("attack 0.005 s, needs 0.5 s");
    expect(result.detail).toContain("release 0.22 s, needs 1 s");
  });

  it("fails a clip that is not 4 bars, or not sparse", () => {
    expect(
      checkPadSound(before, withPad(before, { attack: 1, release: 2, bars: 2 })).detail,
    ).toContain("no 4-bar clip");
    const busy = Array.from({ length: 16 }, (_, step) => [step / 4, [69]] as const);
    expect(
      checkPadSound(before, withPad(before, { attack: 1, release: 2, chords: busy }))
        .detail,
    ).toContain("1 to 8 note starts");
  });

  it("fails a sparse 4-bar clip that is never placed, so the pad is silent", () => {
    const result = checkPadSound(
      before,
      withPad(before, { attack: 1, release: 2, placed: false }),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("its 4-bar clip is not placed on it");
  });

  it("fails no new track", () => {
    expect(checkPadSound(before, before).status).toBe("fail");
  });
});

describe("check 13: dissonant chords", () => {
  const before = createTechnoLoopProject();

  it.each([
    ["a minor 2nd", [69, 70, 76]],
    ["a tritone", [60, 66, 72]],
    ["a major 7th, an octave up", [60, 64, 83]],
  ] as const)("passes a chord with %s", (_name, pitches) => {
    const after = withPad(before, { chords: [[0, pitches]] });
    expect(checkDissonant(before, after).status).toBe("pass");
  });

  it("fails consonant chords", () => {
    const after = withPad(before, {
      chords: [
        [0, [57, 60, 64]],
        [2, [53, 57, 60]],
      ],
    });
    expect(checkDissonant(before, after)).toEqual({
      status: "fail",
      detail: "None of its 2 chords holds a minor 2nd, major 7th or tritone",
    });
  });

  it("fails single notes, and no new synth", () => {
    const after = withPad(before, { chords: [[0, [69]]] });
    expect(checkDissonant(before, after).detail).toBe("The new synth plays no chords");
    expect(checkDissonant(before, before).detail).toBe("Adds no synth track");
  });
});

describe("runCaseCheck", () => {
  it("runs every case check by its ID", () => {
    const before = createTechnoLoopProject();
    const after = withPad(before, { attack: 1, release: 2 });
    const results = Object.fromEntries(
      CASE_CHECK_IDS.map((id) => [
        id,
        runCaseCheck(id, before, after, "Try the Generate panel.").status,
      ]),
    );
    expect(results).toEqual({
      hatDensity: "fail",
      pointsToGenerate: "pass",
      developsTrack: "fail",
      padSound: "pass",
      dissonant: "pass",
      // GRV-107's: the fixture's loop adds a pad but no track and no command.
      addsTracks: "pass",
      endsAt: "fail",
      noEmptyClips: "pass",
      noNoOps: "pass",
      // GRV-119's: no action named, so neither can judge.
      exactEdit: "fail",
      nothingElse: "fail",
      // The fixture's pad clip is placed.
      clipsPlaced: "pass",
      // GRV-129's: the turn recommended no sounds.
      recommendationTargets: "fail",
    });
  });
});

describe("checkRecommendationTargets (GRV-129)", () => {
  const project = createTechnoDrumsProject();
  const drums = project.song.tracks[0];
  const pads = drums?.instrument?.kind === "drumMachine" ? drums.instrument.pads : [];
  const library = evalLibrary();
  const recommend = (soundId: string, target: { trackId?: string; padId?: string }) => ({
    id: `toolu_${soundId}`,
    name: "recommend_sounds",
    input: {
      packId: "pak_SdlN_OazweXrwury0j27Y",
      soundIds: [soundId],
      reason: "Fits.",
      ...target,
    },
  });

  it("fails a turn that recommended nothing", () => {
    expect(checkRecommendationTargets(project, [], library)).toEqual({
      status: "fail",
      detail: "The turn recommended no sounds",
    });
  });

  it("passes a kick, a snare and a hat each on a pad of their own", () => {
    const [kick, snare, hat] = pads;
    const result = checkRecommendationTargets(
      project,
      [
        recommend("sg-one-shot-drums-kick-0002", { trackId: drums?.id, padId: kick?.id }),
        recommend("sg-one-shot-drums-snare-0001", {
          trackId: drums?.id,
          padId: snare?.id,
        }),
        recommend("sg-one-shot-drums-closed-hat-0001", {
          trackId: drums?.id,
          padId: hat?.id,
        }),
      ],
      library,
    );
    expect(result.status).toBe("pass");
  });

  it("fails one aimed at a track the song does not have", () => {
    const result = checkRecommendationTargets(
      project,
      [
        recommend("sg-one-shot-drums-snare-0001", {
          trackId: "trk_Nowhere00000000000001",
        }),
      ],
      library,
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/no track/);
  });

  it("fails two parts on one pad, and on the selected pad when neither names one", () => {
    const [kick] = pads;
    const onKick = checkRecommendationTargets(
      project,
      [
        recommend("sg-one-shot-drums-kick-0002", { trackId: drums?.id, padId: kick?.id }),
        recommend("sg-one-shot-drums-snare-0001", {
          trackId: drums?.id,
          padId: kick?.id,
        }),
      ],
      library,
    );
    expect(onKick.detail).toMatch(/snare and the kick are both aimed at/);
    const unnamed = checkRecommendationTargets(
      project,
      [
        recommend("sg-one-shot-drums-kick-0002", {}),
        recommend("sg-one-shot-drums-closed-hat-0001", {}),
      ],
      library,
    );
    expect(unnamed.status).toBe("fail");
  });
});
