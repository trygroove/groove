import { describe, expect, it } from "vitest";
import { createDevice } from "../../domain/devices";
import type { Project } from "../../domain/entities";
import { TICKS_PER_BAR, TICKS_PER_SIXTEENTH } from "../../domain/time";
import type { FactoryLibraryEntry } from "../../library/factoryLibrary";
import { factoryLibrary } from "../../library/factoryLibrary";
import { BASIC_ACTION_CASES } from "./basicActionCases";
import { changedPaths, checkNothingElse } from "./basicActionChecks";
import { createBasicKitProject, createBasicNotesProject } from "./basicActionFixtures";
import {
  checkLongerSample,
  doublesSpeed,
  libraryEntryOf,
} from "./basicActionSoundChecks";
import { checkOutcome } from "./caseChecks";
import type { EvalCase } from "./cases";

/** A loosely typed draft: the tests hand-build results the way an edit would leave them. */
// biome-ignore lint/suspicious/noExplicitAny: hand-built test drafts
type Draft = any;

function edited(project: Project, change: (draft: Draft) => void): Project {
  const draft = structuredClone(project);
  change(draft);
  return draft;
}

const track = (draft: Draft, name: string) =>
  draft.song.tracks.find((entry: Draft) => entry.name === name);
const clip = (draft: Draft, name: string) =>
  draft.clips.find((entry: Draft) => entry.name === name);
const placementOf = (draft: Draft, trackName: string) =>
  draft.song.placements.find(
    (entry: Draft) => entry.trackId === track(draft, trackName).id,
  );
const placementOfClip = (draft: Draft, clipName: string) =>
  draft.song.placements.find((entry: Draft) => entry.clipId === clip(draft, clipName).id);
const events = (draft: Draft, clipName: string) => clip(draft, clipName).content.events;
const device = (draft: Draft, trackName: string, type: string) =>
  track(draft, trackName).devices.find((entry: Draft) => entry.type === type);
const bars = (count: number) => count * TICKS_PER_BAR;

/** Moves every listed track down one place and puts `name` first. */
function toTop(draft: Draft, name: string) {
  const moved = track(draft, name);
  for (const entry of draft.song.tracks) {
    if (entry.order < moved.order) entry.order += 1;
  }
  moved.order = 0;
}

/**
 * For each case, an edit that does what it asks (and only that), and one
 * that gets the edit itself wrong.
 */
const EDITS: Record<
  string,
  { right: (draft: Draft) => void; wrong: (draft: Draft) => void }
> = {
  "basic-extend-loop": {
    right: (d) =>
      Object.assign(placementOfClip(d, "Loop"), {
        durationTicks: bars(16),
        looped: true,
      }),
    wrong: (d) => Object.assign(placementOfClip(d, "Loop"), { durationTicks: bars(16) }),
  },
  "basic-duplicate-chorus": {
    right: (d) =>
      d.song.placements.push({
        ...placementOfClip(d, "Chorus"),
        id: "plc_copy",
        startTicks: bars(16),
      }),
    wrong: (d) =>
      d.song.placements.push({
        ...placementOfClip(d, "Chorus"),
        id: "plc_copy",
        startTicks: bars(17),
      }),
  },
  "basic-trim-drums": {
    right: (d) => Object.assign(placementOf(d, "Drums"), { durationTicks: bars(12) }),
    wrong: (d) =>
      Object.assign(placementOf(d, "Drums"), {
        startTicks: bars(4),
        durationTicks: bars(12),
      }),
  },
  "basic-move-bass": {
    right: (d) => Object.assign(placementOf(d, "Bass"), { startTicks: bars(8) }),
    wrong: (d) =>
      Object.assign(placementOf(d, "Bass"), {
        startTicks: bars(8),
        durationTicks: bars(8),
      }),
  },
  "basic-loop-bars": {
    right: (d) => Object.assign(d.song.loop, { startTicks: bars(4), endTicks: bars(8) }),
    wrong: (d) => Object.assign(d.song.loop, { startTicks: bars(4), endTicks: bars(9) }),
  },
  "basic-delete-pad": {
    right: (d) => {
      const pad = track(d, "Pad");
      d.song.tracks = d.song.tracks.filter((entry: Draft) => entry.id !== pad.id);
      d.clips = d.clips.filter((entry: Draft) => entry.trackId !== pad.id);
      d.song.placements = d.song.placements.filter(
        (entry: Draft) => entry.trackId !== pad.id,
      );
      track(d, "Vocals").order -= 1;
    },
    wrong: (d) => {
      d.song.tracks = d.song.tracks.filter((entry: Draft) => entry.name !== "Pad");
    },
  },
  "basic-add-synth": {
    right: (d) =>
      d.song.tracks.push({ ...track(d, "Bass"), id: "trk_new", name: "Synth", order: 7 }),
    wrong: (d) =>
      d.song.tracks.push({ ...track(d, "Kick"), id: "trk_new", name: "Synth", order: 7 }),
  },
  "basic-add-drum-machine": {
    right: (d) =>
      d.song.tracks.push({ ...track(d, "Kick"), id: "trk_new", name: "Drums", order: 7 }),
    wrong: (d) =>
      d.song.tracks.push({ ...track(d, "Bass"), id: "trk_new", name: "Drums", order: 7 }),
  },
  "basic-rename-track": {
    right: (d) => {
      track(d, "Hats").name = "Lead";
    },
    wrong: (d) => {
      track(d, "Bass").name = "Lead";
    },
  },
  "basic-mute-hats": {
    right: (d) => {
      track(d, "Hats").mixer.muted = true;
    },
    wrong: (d) => {
      track(d, "Hats").mixer.soloed = true;
    },
  },
  "basic-solo-bass": {
    right: (d) => {
      track(d, "Bass").mixer.soloed = true;
    },
    wrong: (d) => {
      track(d, "Bass").mixer.muted = true;
    },
  },
  "basic-vocals-to-top": {
    right: (d) => toTop(d, "Vocals"),
    wrong: (d) => {
      track(d, "Kick").order = track(d, "Vocals").order;
      track(d, "Vocals").order = 0;
    },
  },
  "basic-kick-down": {
    right: (d) => {
      track(d, "Kick").mixer.volume -= 3;
    },
    wrong: (d) => {
      track(d, "Kick").mixer.volume -= 1;
    },
  },
  "basic-pan-guitar": {
    right: (d) => {
      track(d, "Guitar").mixer.pan = -0.5;
    },
    wrong: (d) => {
      track(d, "Guitar").mixer.pan = 0.5;
    },
  },
  "basic-add-clap": {
    right: (d) => {
      const clap = d.song.assets.find((asset: Draft) => asset.name.match(/clap/i));
      const [kick] = track(d, "Drums").instrument.pads;
      track(d, "Drums").instrument.pads.push({
        ...kick,
        id: "pad_clap",
        name: "Clap",
        assetId: clap.id,
      });
    },
    wrong: (d) => {
      const [kick] = track(d, "Drums").instrument.pads;
      track(d, "Drums").instrument.pads.push({ ...kick, id: "pad_clap", name: "Clap" });
    },
  },
  "basic-synth-to-sampler": {
    right: (d) => {
      track(d, "Synth").instrument = { kind: "sampler", assetId: null, parameters: {} };
    },
    wrong: (d) => {
      track(d, "Synth").instrument = { kind: "sampler", assetId: null, parameters: {} };
      d.clips = d.clips.filter((entry: Draft) => entry.name !== "Riff");
      d.song.placements = d.song.placements.filter(
        (entry: Draft) => entry.trackId !== track(d, "Synth").id,
      );
    },
  },
  "basic-lower-cutoff": {
    right: (d) => {
      track(d, "Synth").instrument.parameters.filterCutoff = 1_000;
    },
    wrong: (d) => {
      track(d, "Synth").instrument.parameters.filterCutoff = 8_000;
    },
  },
  "basic-add-reverb": {
    right: (d) =>
      track(d, "Snare").devices.push(createDevice("dev_new" as never, "reverb", 0)),
    wrong: (d) =>
      track(d, "Snare").devices.push(createDevice("dev_new" as never, "delay", 0)),
  },
  "basic-remove-reverb": {
    right: (d) => {
      track(d, "Snare").devices = [];
    },
    wrong: (d) => {
      device(d, "Snare", "reverb").bypassed = true;
    },
  },
  "basic-wetter-reverb": {
    right: (d) => {
      device(d, "Vocals", "reverb").parameters.wet = 0.5;
    },
    wrong: (d) => {
      device(d, "Vocals", "reverb").parameters.wet = 0.1;
    },
  },
  "basic-delay-before-reverb": {
    right: (d) => {
      device(d, "Vocals", "delay").order = 0;
      device(d, "Vocals", "reverb").order = 1;
    },
    wrong: (d) => {
      const vocals = track(d, "Vocals");
      vocals.devices = [
        createDevice("dev_again" as never, "delay", 0),
        { ...device(d, "Vocals", "reverb"), order: 1 },
      ];
    },
  },
  "basic-reverb-send": {
    right: (d) => {
      d.song.returns.push({
        id: "rtn_new",
        name: "Reverb",
        order: 0,
        devices: [createDevice("dev_new" as never, "reverb", 0)],
        mixer: { volume: 0, pan: 0, muted: false },
      });
      for (const name of ["Vocals", "Drums"]) {
        track(d, name).sendConfig.push({
          returnId: "rtn_new",
          level: -12,
          preFader: false,
        });
      }
    },
    wrong: (d) => {
      d.song.returns.push({
        id: "rtn_new",
        name: "Reverb",
        order: 0,
        devices: [createDevice("dev_new" as never, "reverb", 0)],
        mixer: { volume: 0, pan: 0, muted: false },
      });
      track(d, "Vocals").sendConfig.push({
        returnId: "rtn_new",
        level: -12,
        preFader: false,
      });
    },
  },
  "basic-quantize-hats": {
    right: (d) => {
      for (const event of events(d, "Hats")) {
        event.startTicks =
          Math.round(event.startTicks / TICKS_PER_SIXTEENTH) * TICKS_PER_SIXTEENTH;
      }
    },
    wrong: (d) => {
      events(d, "Hats")[0].startTicks = 0;
    },
  },
  "basic-transpose-melody": {
    right: (d) => {
      for (const event of events(d, "Melody")) event.trigger.pitch += 12;
    },
    wrong: (d) => {
      for (const event of events(d, "Melody")) event.trigger.pitch += 7;
    },
  },
  "basic-humanize-hats": {
    right: (d) => {
      events(d, "Hats").forEach((event: Draft, index: number) => {
        event.velocity = index % 2 === 0 ? 0.8 : 0.55;
      });
    },
    wrong: (d) => {
      events(d, "Hats").pop();
    },
  },
  "basic-double-speed": {
    right: (d) => {
      for (const event of events(d, "Bassline")) {
        event.startTicks /= 2;
        event.durationTicks /= 2;
      }
    },
    wrong: (d) => {
      for (const event of events(d, "Bassline")) event.startTicks /= 2;
    },
  },
  "basic-clear-clip": {
    right: (d) => {
      clip(d, "Chords").content.events = [];
    },
    wrong: (d) => {
      clip(d, "Chords").content.events.pop();
    },
  },
  "basic-tempo": {
    right: (d) => {
      d.song.tempo = 124;
    },
    wrong: (d) => {
      d.song.tempo = 125;
    },
  },
  "basic-key": {
    right: (d) => {
      d.song.key = { root: 9, scale: "minor" };
    },
    wrong: (d) => {
      d.song.key = { root: 0, scale: "minor" };
    },
  },
  "basic-undo": {
    right: (d) => {
      track(d, "Hats").mixer.muted = false;
    },
    wrong: (d) => {
      track(d, "Bass").mixer.muted = true;
    },
  },
};

/** The cases the table covers: every one but the two judged apart below. */
const TABLED = BASIC_ACTION_CASES.filter(
  (entry) => !["basic-longer-kick", "basic-missing-track"].includes(entry.id),
);

function judge(evalCase: EvalCase, after: Project) {
  const before = evalCase.fixture();
  const action = evalCase.action;
  if (!action) throw new Error(`${evalCase.id} has no action`);
  return {
    target: action.target(before, after).status,
    nothingElse: checkNothingElse(before, after, action.allows(before, after)).status,
  };
}

describe("the basic production actions' checks", () => {
  it("cover every case but the longer kick and the missing track in the table", () => {
    expect(Object.keys(EDITS).sort()).toEqual(TABLED.map((entry) => entry.id).sort());
  });

  it.each(TABLED.map((entry) => [entry.id, entry] as const))(
    "%s: pass the right edit, fail a wrong one, a stray change and no change",
    (id, evalCase) => {
      const before = evalCase.fixture();
      const right = edited(before, EDITS[id].right);
      expect(judge(evalCase, right)).toEqual({ target: "pass", nothingElse: "pass" });
      expect(judge(evalCase, edited(before, EDITS[id].wrong)).target).toBe("fail");
      // The right edit and one more change anywhere else: the master is in no case's reach.
      const stray = edited(right, (draft) => {
        draft.song.master.volume -= 1;
      });
      expect(judge(evalCase, stray)).toEqual({ target: "pass", nothingElse: "fail" });
      // Changing nothing never passes as the edit.
      expect(judge(evalCase, before)).toEqual({ target: "fail", nothingElse: "pass" });
    },
  );

  /**
   * The right edit plus a change a model might plausibly slip in beside it:
   * on another track, or reshuffling the tracks. Each must fail
   * `nothingElse` while the edit itself still passes.
   */
  const STRAYS: readonly (readonly [
    id: string,
    what: string,
    stray: (d: Draft) => void,
  ])[] = [
    [
      "basic-add-synth",
      "a placement of the Bassline on the Bass track",
      (d) =>
        d.song.placements.push({
          ...placementOf(d, "Bass"),
          id: "plc_x",
          startTicks: bars(8),
        }),
    ],
    ["basic-add-synth", "the vocals moved to the top", (d) => toTop(d, "Vocals")],
    [
      "basic-add-drum-machine",
      "a new clip on the Kick track",
      (d) => d.clips.push({ ...clip(d, "Kick beat"), id: "clp_x" }),
    ],
    ["basic-delete-pad", "the vocals moved to the top", (d) => toTop(d, "Vocals")],
    [
      "basic-duplicate-chorus",
      "a second placement of the drums' Beat",
      (d) =>
        d.song.placements.push({
          ...placementOfClip(d, "Beat"),
          id: "plc_x",
          startTicks: bars(16),
        }),
    ],
    [
      "basic-duplicate-chorus",
      "a second copy of the chorus",
      (d) =>
        d.song.placements.push({
          ...placementOfClip(d, "Chorus"),
          id: "plc_x",
          startTicks: bars(18),
        }),
    ],
    [
      "basic-trim-drums",
      "the drums placement no longer looped",
      (d) => {
        placementOf(d, "Drums").looped = false;
      },
    ],
    [
      "basic-add-clap",
      "the unused long kick taken out of the project",
      (d) => {
        d.song.assets = d.song.assets.filter(
          (asset: Draft) => !asset.name.match(/rumble/i),
        );
      },
    ],
    [
      "basic-add-reverb",
      "a delay as well",
      (d) => track(d, "Snare").devices.push(createDevice("dev_x" as never, "delay", 1)),
    ],
    [
      "basic-reverb-send",
      "a send from the bass too",
      (d) =>
        track(d, "Bass").sendConfig.push({
          returnId: "rtn_new",
          level: -12,
          preFader: false,
        }),
    ],
    [
      "basic-double-speed",
      "the clip renamed",
      (d) => {
        clip(d, "Bassline").name = "Fast";
      },
    ],
  ];

  it.each(STRAYS)("%s: fails the right edit plus %s", (id, _what, stray) => {
    const evalCase = TABLED.find((entry) => entry.id === id);
    if (!evalCase) throw new Error(`no case ${id}`);
    const right = edited(evalCase.fixture(), EDITS[id].right);
    expect(judge(evalCase, edited(right, stray))).toEqual({
      target: "pass",
      nothingElse: "fail",
    });
  });

  it("passes a new track placed among the others without reshuffling them", () => {
    const evalCase = TABLED.find((entry) => entry.id === "basic-add-synth");
    if (!evalCase) throw new Error("no add-synth case");
    const after = edited(evalCase.fixture(), (d) => {
      for (const entry of d.song.tracks) if (entry.order >= 3) entry.order += 1;
      d.song.tracks.push({ ...track(d, "Bass"), id: "trk_new", name: "Synth", order: 3 });
      d.clips.push({ ...clip(d, "Bassline"), id: "clp_new", trackId: "trk_new" });
      d.song.placements.push({
        ...placementOf(d, "Bass"),
        id: "plc_new",
        clipId: "clp_new",
        trackId: "trk_new",
      });
    });
    expect(judge(evalCase, after)).toEqual({ target: "pass", nothingElse: "pass" });
  });

  it("passes the hats quantized only to their nearest 16th", () => {
    const evalCase = TABLED.find((entry) => entry.id === "basic-quantize-hats");
    if (!evalCase) throw new Error("no quantize case");
    // Every note on the grid, but each a 16th later than its nearest.
    const late = edited(evalCase.fixture(), (d) => {
      for (const event of events(d, "Hats")) {
        event.startTicks =
          Math.round(event.startTicks / TICKS_PER_SIXTEENTH) * TICKS_PER_SIXTEENTH +
          TICKS_PER_SIXTEENTH;
      }
    });
    expect(judge(evalCase, late).target).toBe("fail");
  });

  it("passes a doubled bassline repeated to fill its clip", () => {
    const before = createBasicNotesProject();
    const after = edited(before, (d) => {
      const halved = events(d, "Bassline").map((event: Draft) => ({
        ...event,
        startTicks: event.startTicks / 2,
        durationTicks: event.durationTicks / 2,
      }));
      clip(d, "Bassline").content.events = [
        ...halved,
        ...halved.map((event: Draft) => ({
          ...event,
          id: `${event.id}x`,
          startTicks: event.startTicks + bars(1) / 2,
        })),
      ];
    });
    expect(doublesSpeed("Bassline").target(before, after).status).toBe("pass");
  });
});

describe("a longer kick sample (case 13)", () => {
  const before = createBasicKitProject();
  const action = BASIC_ACTION_CASES.find(
    (entry) => entry.id === "basic-longer-kick",
  )?.action;
  if (!action) throw new Error("no longer-kick case");
  const kickAsset = (project: Project) => {
    const drums = project.song.tracks[0].instrument;
    const pad = drums?.kind === "drumMachine" ? drums.pads[0] : null;
    return project.song.assets.find((asset) => asset.id === pad?.assetId);
  };
  const kick = kickAsset(before);
  const kickEntry = libraryEntryOf(kick);
  if (!kick || !kickEntry) throw new Error("The kit's kick is not a factory sound");
  /** The factory kick in the project that no pad plays: longer than the Kick pad's. */
  const longKick = before.song.assets.find(
    (asset) => asset.id !== kick.id && libraryEntryOf(asset)?.role === "kick",
  );
  if (!longKick) throw new Error("The kit holds no second kick");
  /** A library with a second kick in it, `seconds` long. */
  const libraryWith = (role: string, seconds: number): FactoryLibraryEntry[] => [
    ...factoryLibrary(),
    {
      ...kickEntry,
      key: "fakeKick",
      storageRef: "fake/kick.wav",
      role,
      durationSeconds: seconds,
    },
  ];
  /** The kick pad on a new asset `seconds` long. */
  const swapped = (seconds: number) =>
    edited(before, (d) => {
      d.song.assets.push({
        ...kick,
        id: "ast_fake",
        storageRef: "fake/kick.wav",
        durationSeconds: seconds,
      });
      d.song.tracks[0].instrument.pads[0].assetId = "ast_fake";
    });
  /** The kick pad on the long factory kick the project already holds. */
  const onLongKick = edited(before, (d) => {
    d.song.tracks[0].instrument.pads[0].assetId = longKick.id;
  });
  const status = (after: Project, library?: FactoryLibraryEntry[]) =>
    checkLongerSample(before, after, "Drums", "Kick", "kick", library).status;
  const nothingElse = (after: Project) =>
    checkNothingElse(before, after, action.allows(before, after)).status;

  it("holds a longer factory kick the Kick pad can point at", () => {
    expect(longKick.durationSeconds ?? 0).toBeGreaterThan(
      kick.durationSeconds ?? Number.POSITIVE_INFINITY,
    );
  });

  it("passes the pad pointed at the longer kick, and leaves the rest alone", () => {
    expect(status(onLongKick)).toBe("pass");
    expect(nothingElse(onLongKick)).toBe("pass");
    const after = swapped(0.9);
    expect(status(after, libraryWith("kick", 0.9))).toBe("pass");
    expect(nothingElse(after)).toBe("pass");
  });

  it("lets the old kick go once no pad plays it, and nothing else in the sounds", () => {
    const dropped = edited(onLongKick, (d) => {
      d.song.assets = d.song.assets.filter((asset: Draft) => asset.id !== kick.id);
    });
    expect(nothingElse(dropped)).toBe("pass");
    const clapGone = edited(onLongKick, (d) => {
      d.song.assets = d.song.assets.filter((asset: Draft) => !asset.name.match(/clap/i));
    });
    expect(nothingElse(clapGone)).toBe("fail");
    const unused = edited(onLongKick, (d) => {
      d.song.assets.push({ ...kick, id: "ast_unused" });
    });
    expect(nothingElse(unused)).toBe("fail");
  });

  it("fails a longer decay on the same sample, a shorter kick, and a sample that is not a kick", () => {
    const decayed = edited(before, (d) => {
      d.song.tracks[0].instrument.pads[0].parameters.decay = 2;
    });
    expect(status(decayed, libraryWith("kick", 0.9))).toBe("fail");
    expect(status(swapped(0.2), libraryWith("kick", 0.2))).toBe("fail");
    expect(status(swapped(0.9), libraryWith("snare", 0.9))).toBe("fail");
  });

  it("fails a swap that changes another pad too", () => {
    const after = edited(onLongKick, (d) => {
      d.song.tracks[0].instrument.pads[1].mixer.volume = -6;
    });
    expect(status(after)).toBe("fail");
  });
});

describe("a track that is not there (case 30)", () => {
  const evalCase = BASIC_ACTION_CASES.find((entry) => entry.id === "basic-missing-track");

  it("expects no proposal, and a question or an explanation", () => {
    expect(evalCase?.expect).toBe("explain");
    const text = "There's no strings track in this project.";
    expect(checkOutcome("explain", { proposal: null, text }).status).toBe("pass");
    expect(
      checkOutcome("explain", { proposal: null, ask: { question: "Which track?" } })
        .status,
    ).toBe("pass");
    expect(checkOutcome("explain", { proposal: null, text: "" }).status).toBe("fail");
    expect(checkOutcome("explain", { proposal: {}, text }).status).toBe("fail");
  });

  it("fails any proposal it makes anyway", () => {
    if (!evalCase?.action) throw new Error("no missing-track case");
    const before = evalCase.fixture();
    expect(evalCase.action.target(before, before).status).toBe("fail");
  });
});

describe("changedPaths", () => {
  it("keys entities by ID, so reordering a list is no change", () => {
    const before = createBasicKitProject();
    const after = edited(before, (d) => {
      d.song.tracks[0].instrument.pads.reverse();
    });
    expect(changedPaths(before, after)).toEqual([]);
  });

  it("names what was added and removed by its path", () => {
    const before = createBasicKitProject();
    const after = edited(before, (d) => {
      d.song.tracks[0].mixer.muted = true;
    });
    expect(changedPaths(before, after)).toEqual([
      `song.tracks.${before.song.tracks[0].id}.mixer.muted`,
    ]);
  });
});
