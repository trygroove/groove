import { describe, expect, it } from "vitest";
import type { Device, Project, Track } from "../domain/entities";
import { createReferenceProject } from "../domain/fixtures";
import type { AskPredicate, AssistantAsk } from "./ask";
import { optionDoneByEdit, predicateHolds } from "./askPredicates";

const asked = createReferenceProject();
const [first, second] = asked.song.tracks;
if (!first || !second) throw new Error("the reference project needs two tracks");

function withSong(project: Project, song: Partial<Project["song"]>): Project {
  return { ...project, song: { ...project.song, ...song } };
}

function withTrack(project: Project, trackId: string, change: Partial<Track>): Project {
  return withSong(project, {
    tracks: project.song.tracks.map((track) =>
      track.id === trackId ? { ...track, ...change } : track,
    ),
  });
}

function withMixer(project: Project, trackId: string, change: Partial<Track["mixer"]>) {
  const track = project.song.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`no track ${trackId}`);
  return withTrack(project, trackId, { mixer: { ...track.mixer, ...change } });
}

const device = (type: string): Device => ({
  id: `dev_${type}` as Device["id"],
  type,
  order: 0,
  bypassed: false,
  parameters: {},
  preset: null,
});

describe("answering a question by doing (GRV-42)", () => {
  it("holds a tempo once the song moves into the range, not while it already was", () => {
    const predicate: AskPredicate = { kind: "tempo", max: 100 };
    expect(predicateHolds(predicate, asked, withSong(asked, { tempo: 92 }))).toBe(true);
    expect(predicateHolds(predicate, asked, asked)).toBe(false);
    const slow = withSong(asked, { tempo: 90 });
    expect(predicateHolds(predicate, slow, withSong(slow, { tempo: 95 }))).toBe(false);
  });

  it("holds a swing once the song moves into the range, not while it already was", () => {
    const predicate: AskPredicate = { kind: "swing", min: 55 };
    const straight = withSong(asked, { swing: 50 });
    expect(predicateHolds(predicate, straight, withSong(straight, { swing: 58 }))).toBe(
      true,
    );
    expect(predicateHolds(predicate, straight, straight)).toBe(false);
    expect(predicateHolds(predicate, straight, withSong(straight, { swing: 54 }))).toBe(
      false,
    );
    const swung = withSong(asked, { swing: 60 });
    expect(predicateHolds(predicate, swung, withSong(swung, { swing: 66 }))).toBe(false);
  });

  it("answers a swing question by the producer's own swing change", () => {
    const straight = withSong(asked, { swing: 50 });
    const ask: AssistantAsk = {
      id: "toolu_swing",
      question: "How much swing?",
      options: [
        { label: "Straight" },
        { label: "Light", doneWhen: { kind: "swing", min: 54, max: 62 } },
        { label: "Heavy", doneWhen: { kind: "swing", min: 63 } },
      ],
      multiSelect: false,
    };
    const at = (swing: number) => withSong(straight, { swing });
    expect(optionDoneByEdit(ask, straight, straight, at(58))).toBe(1);
    expect(optionDoneByEdit(ask, straight, at(58), at(70))).toBe(2);
    expect(optionDoneByEdit(ask, straight, straight, at(52))).toBeNull();
    // A tempo change answers no swing question.
    expect(
      optionDoneByEdit(ask, straight, straight, withSong(straight, { tempo: 90 })),
    ).toBeNull();
  });

  it("holds a mute or solo once the track's flag changes to it", () => {
    const predicate: AskPredicate = {
      kind: "trackFlag",
      trackId: first.id,
      flag: "muted",
      value: !first.mixer.muted,
    };
    expect(
      predicateHolds(
        predicate,
        asked,
        withMixer(asked, first.id, { muted: !first.mixer.muted }),
      ),
    ).toBe(true);
    expect(
      predicateHolds(
        predicate,
        asked,
        withMixer(asked, second.id, { muted: !first.mixer.muted }),
      ),
    ).toBe(false);
  });

  it("holds a volume range once the track's fader enters it", () => {
    const predicate: AskPredicate = {
      kind: "trackVolume",
      trackId: first.id,
      min: -12,
      max: -6,
    };
    expect(
      predicateHolds(predicate, asked, withMixer(asked, first.id, { volume: -9 })),
    ).toBe(true);
    expect(
      predicateHolds(predicate, asked, withMixer(asked, first.id, { volume: -3 })),
    ).toBe(false);
  });

  it("holds a track added once there is one more of its kind than when it was asked", () => {
    const copy: Track = { ...first, id: "trk_new" as Track["id"] };
    const added = withSong(asked, { tracks: [...asked.song.tracks, copy] });
    expect(predicateHolds({ kind: "trackAdded" }, asked, added)).toBe(true);
    expect(
      predicateHolds(
        { kind: "trackAdded", instrumentKind: first.instrument?.kind },
        asked,
        added,
      ),
    ).toBe(true);
    const otherKind = first.instrument?.kind === "synth" ? "sampler" : "synth";
    expect(
      predicateHolds({ kind: "trackAdded", instrumentKind: otherKind }, asked, added),
    ).toBe(false);
    expect(predicateHolds({ kind: "trackAdded" }, asked, asked)).toBe(false);
  });

  it("holds a track removed once it is gone", () => {
    const removed = withSong(asked, { tracks: asked.song.tracks.slice(1) });
    expect(
      predicateHolds({ kind: "trackRemoved", trackId: first.id }, asked, removed),
    ).toBe(true);
    expect(
      predicateHolds({ kind: "trackRemoved", trackId: "trk_none" }, asked, removed),
    ).toBe(false);
  });

  it("holds a device added on a track, or of a type, once there is one more", () => {
    const added = withTrack(asked, second.id, {
      devices: [...second.devices, device("eq")],
    });
    expect(predicateHolds({ kind: "deviceAdded" }, asked, added)).toBe(true);
    expect(
      predicateHolds({ kind: "deviceAdded", trackId: second.id }, asked, added),
    ).toBe(true);
    expect(predicateHolds({ kind: "deviceAdded", trackId: first.id }, asked, added)).toBe(
      false,
    );
    expect(predicateHolds({ kind: "deviceAdded", deviceType: "eq" }, asked, added)).toBe(
      true,
    );
    expect(
      predicateHolds({ kind: "deviceAdded", deviceType: "limiter" }, asked, added),
    ).toBe(false);
  });

  it("picks the first option whose change has happened, made by this edit", () => {
    const ask: AssistantAsk = {
      id: "toolu_1",
      question: "Slow it down?",
      options: [
        { label: "Leave it" },
        { label: "Under 100", doneWhen: { kind: "tempo", max: 100 } },
        { label: "Under 110", doneWhen: { kind: "tempo", max: 110 } },
      ],
      multiSelect: false,
    };
    const at = (tempo: number) => withSong(asked, { tempo });
    expect(optionDoneByEdit(ask, asked, asked, asked)).toBeNull();
    expect(optionDoneByEdit(ask, asked, asked, at(105))).toBe(2);
    expect(optionDoneByEdit(ask, asked, asked, at(90))).toBe(1);
    expect(optionDoneByEdit(ask, asked, at(105), at(90))).toBe(1);
    // Something else got it under 100 first: an edit that leaves it there
    // has not done it.
    expect(optionDoneByEdit(ask, asked, at(90), at(95))).toBe(null);
    expect(optionDoneByEdit(ask, asked, at(95), at(95))).toBe(null);
  });
});
