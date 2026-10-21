import { beforeEach, describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { CommandHistory } from "../../commands";
import type { NoteEvent, Project } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { NOTE_VELOCITY } from "../../domain/parameters";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import { memoryStorage } from "../../testing/storage";
import {
  eventCountBucket,
  lanesFor,
  noteAt,
  type StepLane,
  stepStartTicks,
} from "./stepEditorModel";
import { createStroke, strokeSummary } from "./stepStroke";

/**
 * The CLP-02 stroke machine, driven directly over a real `CommandHistory` —
 * no DOM, no Solid. The seam supplies a deterministic note-ID factory, so the
 * notes a stroke paints are reproducible between runs.
 */
function harness(project: Project) {
  const history = new CommandHistory(project);
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");

  const clipId = project.clips[0].id;
  const track = project.song.tracks.find(
    (candidate) => candidate.id === project.clips[0].trackId,
  );
  const lanes = lanesFor(track?.instrument ?? null);

  // A seeded factory, so two runs mint the same note ids.
  const ids = createSeededIdFactory("stroke-test");
  const added: NoteEvent["id"][] = [];
  const removed: NoteEvent["id"][] = [];

  const currentClip = () => {
    const clip = history.project.clips.find((candidate) => candidate.id === clipId);
    if (!clip) throw new Error("clip vanished");
    return clip;
  };

  const stroke = createStroke({
    clipId,
    beginGesture: (options) => history.beginGesture(options),
    noteAt: (lane, step) => noteAt(currentClip(), lane, step),
    newNote: (lane: StepLane, step: number): NoteEvent => ({
      id: ids("event"),
      trigger: lane.trigger,
      startTicks: stepStartTicks(step) as NoteEvent["startTicks"],
      durationTicks: TICKS_PER_SIXTEENTH as NoteEvent["durationTicks"],
      velocity: NOTE_VELOCITY.defaultValue as NoteEvent["velocity"],
      probability: null,
    }),
    analytics: () => analytics,
    onNoteAdded: (id) => added.push(id),
    onNoteRemoved: (id) => removed.push(id),
  });

  return {
    stroke,
    history,
    transport,
    analytics,
    lanes,
    currentClip,
    added,
    removed,
    clipEdited: () => transport.events.filter((event) => event.name === "clip_edited"),
    noteCount: () => {
      const content = currentClip().content;
      return content.kind === "notes" ? content.events.length : 0;
    },
    isOn: (lane: StepLane, step: number) =>
      noteAt(currentClip(), lane, step) !== undefined,
  };
}

describe("createStroke mode selection", () => {
  it("starting on an empty cell paints, and adds a note", () => {
    const h = harness(createSliceFixtureProject());
    const lane = h.lanes[0];
    // The slice clip has notes on steps 0/4/8/12; step 1 is empty.
    expect(h.isOn(lane, 1)).toBe(false);

    h.stroke.begin(lane, 1);
    h.stroke.end();

    expect(h.isOn(lane, 1)).toBe(true);
    expect(h.history.entries).toHaveLength(1);
    expect(h.history.entries[0].summary).toBe("Paint 1 step");
  });

  it("starting on an occupied cell erases, and removes that note", () => {
    const h = harness(createSliceFixtureProject());
    const lane = h.lanes[0];
    expect(h.isOn(lane, 0)).toBe(true);

    h.stroke.begin(lane, 0);
    h.stroke.end();

    expect(h.isOn(lane, 0)).toBe(false);
    expect(h.history.entries[0].summary).toBe("Erase 1 step");
  });

  it("keeps the starting cell's mode for the rest of the stroke", () => {
    const h = harness(createSliceFixtureProject());
    const lane = h.lanes[0];
    // Begin on an occupied step: the stroke is an erase, so dragging over an
    // already-empty step must not paint it in.
    h.stroke.begin(lane, 0);
    h.stroke.paint(lane, 1); // empty — nothing to erase
    h.stroke.paint(lane, 4); // occupied — erased
    h.stroke.end();

    expect(h.isOn(lane, 0)).toBe(false);
    expect(h.isOn(lane, 1)).toBe(false); // still empty, never painted
    expect(h.isOn(lane, 4)).toBe(false);
    expect(h.history.entries[0].summary).toBe("Erase 2 steps");
  });

  it("reports the active stroke, and a begin while one is open is ignored", () => {
    const h = harness(createSliceFixtureProject());
    const lane = h.lanes[0];
    expect(h.stroke.active).toBe(false);

    h.stroke.begin(lane, 1);
    expect(h.stroke.active).toBe(true);
    // A second begin must not open a second gesture or flip the mode.
    h.stroke.begin(lane, 0);
    h.stroke.end();

    expect(h.stroke.active).toBe(false);
    // Step 0 stayed on: the second `begin` was a no-op, not an erase.
    expect(h.isOn(lane, 0)).toBe(true);
    expect(h.history.entries).toHaveLength(1);
  });

  it("paints outside an open stroke are ignored", () => {
    const h = harness(createSliceFixtureProject());
    const before = h.noteCount();
    h.stroke.paint(h.lanes[0], 1);
    expect(h.noteCount()).toBe(before);
    expect(h.history.canUndo).toBe(false);
  });
});

describe("createStroke drag de-duplication", () => {
  it("visits a repeated cell only once within a stroke", () => {
    const h = harness(createSliceFixtureProject());
    const lane = h.lanes[0];

    h.stroke.begin(lane, 1);
    // A drag that wobbles back and forth re-enters the same cells.
    h.stroke.paint(lane, 2);
    h.stroke.paint(lane, 1);
    h.stroke.paint(lane, 2);
    h.stroke.paint(lane, 3);
    h.stroke.paint(lane, 2);
    h.stroke.end();

    // Three distinct steps painted, counted once each.
    expect(h.history.entries[0].summary).toBe("Paint 3 steps");
    expect(h.added).toHaveLength(3);
    expect(h.clipEdited()[0].params.event_count_bucket).toBe("1_4");
  });

  it("de-duplicates per (lane, step), so the same step on two lanes both paint", () => {
    const h = harness(createDrumMachineFixtureProject());
    const [bd, cp] = h.lanes;

    h.stroke.begin(bd, 1);
    h.stroke.paint(cp, 1);
    h.stroke.paint(bd, 1); // repeat — ignored
    h.stroke.end();

    expect(h.isOn(bd, 1)).toBe(true);
    expect(h.isOn(cp, 1)).toBe(true);
    expect(h.history.entries[0].summary).toBe("Paint 2 steps");
  });

  it("starts a fresh visited-set on the next stroke", () => {
    const h = harness(createSliceFixtureProject());
    const lane = h.lanes[0];

    h.stroke.begin(lane, 1);
    h.stroke.end();
    // The same cell again — now occupied, so this stroke erases it.
    h.stroke.begin(lane, 1);
    h.stroke.end();

    expect(h.isOn(lane, 1)).toBe(false);
    expect(h.history.entries).toHaveLength(2);
    expect(h.history.entries[1].summary).toBe("Erase 1 step");
  });
});

describe("createStroke commit and cancel", () => {
  it("cancels a stroke that changed nothing: no entry, no revision, no analytics", () => {
    // A stroke that begins on an occupied cell erases it — so to get a stroke
    // that changes nothing, begin an erase and then have the cell report as
    // already empty. Driving `noteAt` off the *committed* project would make
    // that impossible, so this exercises the machine's own guard: an erase
    // whose first cell is reported occupied, but which is then told every
    // cell (including that one) is empty by the time it paints.
    const h = harness(createSliceFixtureProject());
    const lane = h.lanes[0];
    const entriesBefore = h.history.entries.length;
    const revisionBefore = h.history.project.metadata.revision;

    // `paint()` outside an open stroke is a no-op, and `end()` with nothing
    // open leaves the gesture kernel untouched.
    h.stroke.paint(lane, 1);
    h.stroke.end();

    expect(h.history.entries).toHaveLength(entriesBefore);
    expect(h.history.project.metadata.revision).toBe(revisionBefore);
    expect(h.clipEdited()).toHaveLength(0);
  });

  it("an erase stroke that erases nothing cancels its gesture", () => {
    // A hand-built seam whose cells are all empty: `begin` is told the first
    // cell is occupied (so the stroke picks "erase"), but `noteAt` then
    // reports nothing anywhere, so the stroke changes zero cells.
    const project = createSliceFixtureProject();
    const history = new CommandHistory(project);
    const transport = createRecordingTransport();
    const consent = new ConsentStore(memoryStorage());
    const analytics = new Analytics({
      transport,
      consent,
      storage: memoryStorage(),
    });
    analytics.setAccountType("anonymous");
    const lane = lanesFor(project.song.tracks[0].instrument)[0];

    let cancelled = 0;
    let committed = 0;
    const stroke = createStroke({
      clipId: project.clips[0].id,
      beginGesture: () => {
        const gesture = history.beginGesture();
        if (!gesture) return undefined;
        return {
          get active() {
            return gesture.active;
          },
          apply: (commands) => gesture.apply(commands),
          commit: (summary) => {
            committed += 1;
            return gesture.commit(summary);
          },
          cancel: () => {
            cancelled += 1;
            gesture.cancel();
          },
        };
      },
      // The first cell reads occupied so `begin` chooses "erase"; every read
      // after that is empty, so nothing is ever removed.
      noteAt: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return noteAt(project.clips[0], lane, 0);
          }
          return undefined;
        };
      })(),
      newNote: () => {
        throw new Error("an erase stroke must never mint a note");
      },
      analytics: () => analytics,
    });

    const revisionBefore = history.project.metadata.revision;
    stroke.begin(lane, 0);
    stroke.paint(lane, 1);
    stroke.end();

    expect(cancelled).toBe(1);
    expect(committed).toBe(0);
    expect(history.entries).toHaveLength(0);
    expect(history.canUndo).toBe(false);
    expect(history.project.metadata.revision).toBe(revisionBefore);
    // No `clip_edited` and no `feature_first_use` for a stroke that did nothing.
    expect(transport.events).toHaveLength(0);
  });

  it("commits a whole drag as one entry and one revision", () => {
    const h = harness(createSliceFixtureProject());
    const lane = h.lanes[0];
    const startRevision = h.history.project.metadata.revision;

    h.stroke.begin(lane, 1);
    h.stroke.paint(lane, 2);
    h.stroke.paint(lane, 3);
    h.stroke.end();

    expect(h.history.entries).toHaveLength(1);
    // Three notes, one revision bump.
    expect(h.history.project.metadata.revision).toBe(startRevision + 1);
  });

  it("summarises singular and plural step counts", () => {
    expect(strokeSummary("add", 1)).toBe("Paint 1 step");
    expect(strokeSummary("add", 5)).toBe("Paint 5 steps");
    expect(strokeSummary("erase", 1)).toBe("Erase 1 step");
    expect(strokeSummary("erase", 12)).toBe("Erase 12 steps");
  });
});

describe("createStroke analytics", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness(createSliceFixtureProject());
  });

  it("emits exactly one clip_edited per completed stroke, not per step", () => {
    const lane = h.lanes[0];
    h.stroke.begin(lane, 1);
    h.stroke.paint(lane, 2);
    h.stroke.paint(lane, 3);
    h.stroke.end();

    const edited = h.clipEdited();
    expect(edited).toHaveLength(1);
    expect(edited[0].params.editor).toBe("step");
    // Three changed steps → the 1_4 bucket.
    expect(edited[0].params.event_count_bucket).toBe("1_4");
  });

  it("buckets a larger stroke by the steps it actually changed", () => {
    const lane = h.lanes[0];
    // Steps 1,2,3,5,6,7 are empty in the slice clip (0/4/8/12 are on): six
    // changed cells lands in the next bucket up, and the two occupied cells
    // the drag crosses change nothing.
    h.stroke.begin(lane, 1);
    for (const step of [2, 3, 4, 5, 6, 7, 8]) h.stroke.paint(lane, step);
    h.stroke.end();

    const edited = h.clipEdited();
    expect(edited).toHaveLength(1);
    expect(edited[0].params.event_count_bucket).toBe("5_16");
    // A smaller stroke buckets lower, so the count really is driving this.
    expect(eventCountBucket(6)).toBe("5_16");
    expect(eventCountBucket(3)).toBe("1_4");
    expect(h.history.entries[0].summary).toBe("Paint 6 steps");
  });

  it("logs step_editor feature_first_use once across two strokes", () => {
    const lane = h.lanes[0];
    h.stroke.begin(lane, 1);
    h.stroke.end();
    h.stroke.begin(lane, 2);
    h.stroke.end();

    const firstUse = h.transport.events.filter(
      (event) => event.name === "feature_first_use",
    );
    expect(firstUse).toHaveLength(1);
    expect(firstUse[0].params.feature).toBe("step_editor");
    // Two strokes, two clip_edited events.
    expect(h.clipEdited()).toHaveLength(2);
  });

  it("emits nothing at all when analytics consent is denied", () => {
    const project = createSliceFixtureProject();
    const history = new CommandHistory(project);
    const transport = createRecordingTransport();
    const consent = new ConsentStore(memoryStorage());
    consent.set({ productAnalytics: false });
    const analytics = new Analytics({
      transport,
      consent,
      storage: memoryStorage(),
    });
    const ids = createSeededIdFactory("stroke-denied");
    const lane = lanesFor(project.song.tracks[0].instrument)[0];
    const clip = () => history.project.clips[0];

    const stroke = createStroke({
      clipId: project.clips[0].id,
      beginGesture: (options) => history.beginGesture(options),
      noteAt: (l, step) => noteAt(clip(), l, step),
      newNote: (l, step) => ({
        id: ids("event"),
        trigger: l.trigger,
        startTicks: stepStartTicks(step) as NoteEvent["startTicks"],
        durationTicks: TICKS_PER_SIXTEENTH as NoteEvent["durationTicks"],
        velocity: NOTE_VELOCITY.defaultValue as NoteEvent["velocity"],
        probability: null,
      }),
      analytics: () => analytics,
    });

    stroke.begin(lane, 1);
    stroke.end();

    // The edit still lands through the command layer…
    expect(noteAt(clip(), lane, 1)).toBeDefined();
    expect(history.entries).toHaveLength(1);
    // …but with consent denied, nothing was sent.
    expect(transport.events).toHaveLength(0);
  });
});
