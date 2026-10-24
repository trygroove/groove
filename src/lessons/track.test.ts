import { describe, expect, it } from "vitest";
import type { Project } from "../domain/entities";
import { TICKS_PER_BAR } from "../domain/time";
import {
  applyShowMe,
  lessonContext,
  startedAt,
  starterWorld,
} from "../testing/lessonWorld";
import { lesson, TRACK_LESSON } from "./chapters";
import { cueMessage, lessonCue, wrapUpPointers } from "./cue";
import { BITE_IDS } from "./ids";
import {
  biteOf,
  chapterOf,
  type LessonState,
  type LessonTransition,
  lessonFinished,
  madeBites,
  observe,
  skip,
  startLesson,
  startNextBite,
} from "./session";
import type { LessonSettings, LessonWorld, ShowMe } from "./types";

const settings: LessonSettings = { style: "four_on_the_floor" };

/**
 * Show me as the editor does it, and the time it takes: a play runs on for
 * four bars without the master clipping, and an export is the producer's
 * press.
 */
function show(world: LessonWorld, shown: ShowMe | null): LessonWorld {
  if (shown?.kind === "export") return { ...world, stemExports: world.stemExports + 1 };
  const after = applyShowMe(world, shown);
  return shown?.kind === "play" ? { ...after, bar: after.bar + 4, barsHeard: 4 } : after;
}

/** A fresh seed for every Show me, so no two walks mint the same IDs. */
let seed = 1_000;

interface Walk {
  readonly world: LessonWorld;
  readonly events: LessonTransition["event"][];
  readonly bites: string[];
}

/** Every step of the lesson from `start`, by Show me alone, to its end. */
function walk(start: LessonTransition, world: LessonWorld): Walk {
  let transition: LessonTransition | null = start;
  let now = world;
  const events: LessonTransition["event"][] = [start.event];
  const bites: string[] = [biteOf(start.state).id];
  for (let guard = 0; transition && guard < 200; guard += 1) {
    let state: LessonState = transition.state;
    if (state.step) {
      const step = biteOf(state).steps[state.step.index];
      now = show(now, step.showMe(now, settings, lessonContext(seed++)));
      transition = observe(state, now, settings);
      if (!transition)
        throw new Error(`${biteOf(state).id}: Show me did not finish "${step.id}"`);
      events.push(transition.event);
      // Stopped between steps, as the producer would.
      now = { ...now, playing: false };
      continue;
    }
    if (lessonFinished(state)) break;
    transition = startNextBite(state, now, settings);
    if (!transition) break;
    state = transition.state;
    events.push(transition.event);
    bites.push(biteOf(state).id);
  }
  return { world: now, events, bites };
}

/** Skips every step of the bite under way, to its end. */
function skipBite(state: LessonState, world: LessonWorld): LessonTransition {
  let transition = skip(state, world, settings);
  while (transition?.state.step) transition = skip(transition.state, world, settings);
  if (!transition) throw new Error("not skipped");
  return transition;
}

/** The starter with the whole beat made, by "Make a beat"'s Show me. */
function beatMade(): LessonWorld {
  return walk(startedAt("beat", "beat-kick", starterWorld(), settings), starterWorld())
    .world;
}

/** The track started fresh in `world`. */
function trackStart(world: LessonWorld): LessonTransition {
  const started = startLesson("track", null, world, settings);
  if (!started) throw new Error("not started");
  return started;
}

describe("Finish a track (GRV-44)", () => {
  it("is five chapters, from a beat to stems", () => {
    expect(TRACK_LESSON.chapters.map((one) => one.title)).toEqual([
      "Make a beat",
      "Bass",
      "Chords and hook",
      "Arrange, subtractively",
      "Mix and export",
    ]);
    expect(lesson("track")).toBe(TRACK_LESSON);
  });

  it("passes over the kick the starter already plays, and teaches the rest of the beat", () => {
    const world = starterWorld();
    expect(madeBites("beat", world, settings)).toEqual(["beat-kick"]);
    const started = trackStart(world);
    expect(biteOf(started.state).id).toBe("beat-library");
    expect(started.state).toMatchObject({ lessonId: "track", chapterIndex: 0 });
    expect(started.event).toEqual({ kind: "bite_started", passed: [] });
    // Picking a kick is taught; the kick's own bite is passed over when it comes.
    const picked = skip(started.state, world, settings);
    if (!picked) throw new Error("not skipped");
    expect(picked.event).toMatchObject({ kind: "bite_done", chapterDone: false });
    const next = startNextBite(picked.state, world, settings);
    expect(next && biteOf(next.state).id).toBe("beat-play");
    expect(next?.event).toEqual({ kind: "bite_started", passed: ["beat-kick"] });
  });

  it("passes the whole beat over in a song that has one, and starts on the bass", () => {
    const started = trackStart(beatMade());
    expect(biteOf(started.state).id).toBe("bass-key");
    expect(started.event).toEqual({
      kind: "bite_started",
      passed: [
        "beat-library",
        "beat-kick",
        "beat-play",
        "beat-snare",
        "beat-hats",
        "beat-loop",
      ],
    });
    const cue = lessonCue(started.state, started.event, settings, []);
    expect(cue.track).toEqual({
      title: "Finish a track",
      chapterNumber: 2,
      chapterCount: 5,
    });
    expect(cue.passed).toContain("Pick a kick");
    expect(cueMessage(started.state, started.event)).toMatch(/already has/);
  });

  it("runs from the bass to the stems by Show me alone, chapter after chapter", () => {
    const world = beatMade();
    const run = walk(trackStart(world), world);

    expect(run.bites).toEqual(BITE_IDS.filter((id) => !/^(beat|sound|tour)-/.test(id)));
    const ends = run.events.filter((event) => event.kind === "bite_done");
    expect(ends.filter((event) => event.chapterDone)).toHaveLength(4);
    expect(ends.at(-1)).toMatchObject({ chapterDone: true, lessonDone: true });
    expect(ends.filter((event) => event.lessonDone)).toHaveLength(1);

    // The song it leaves: every part, arranged and mixed, ending at bar 28.
    const song = run.world.project.song;
    expect(song.tracks.map((track) => track.name)).toEqual([
      "BD",
      "Bass",
      "Chords",
      "Hook",
    ]);
    expect(song.key).toEqual({ root: 9, scale: "minor" });
    expect(Math.max(...song.placements.map((p) => p.startTicks + p.durationTicks))).toBe(
      28 * TICKS_PER_BAR,
    );
    expect(run.world.stemExports).toBe(1);
  });

  it("goes on to the next chapter after a chapter's last bite", () => {
    const world = beatMade();
    const bass = trackStart(world);
    let state = bass.state;
    while (chapterOf(state).id === "bass") {
      const ended = skipBite(state, world);
      if (ended.event.kind === "bite_done" && ended.event.chapterDone) {
        expect(ended.event.lessonDone).toBe(false);
        expect(cueMessage(ended.state, ended.event)).toMatch(
          /Next is chapter 3 of "Finish a track"/,
        );
      }
      const next = startNextBite(ended.state, world, settings);
      if (!next) throw new Error("nothing next");
      state = next.state;
    }
    expect(state).toMatchObject({ chapterIndex: 2, biteIndex: 0 });
    // How the earlier chapter's bites ended stays with the lesson.
    expect(state.endings).toMatchObject({ "bass-key": "skipped" });
  });

  it("ends with the track: the last bite's cue is its wrap-up", () => {
    const world = starterWorld();
    const started = startedAt("track", "mix-export", world, settings);
    const ended = observe(started.state, { ...world, stemExports: 1 }, settings);
    if (!ended) throw new Error("not ended");
    expect(ended.event).toMatchObject({
      kind: "bite_done",
      chapterDone: true,
      lessonDone: true,
    });
    const cue = lessonCue(ended.state, ended.event, settings, []);
    expect(cue.moment).toBe("track_done");
    expect(cue.next.length).toBeGreaterThan(0);
    expect(cueMessage(ended.state, ended.event)).toMatch(/last bite of "Finish a track"/);
    expect(startNextBite(ended.state, world, settings)).toBeNull();
  });

  it("points a chapter's wrap-up at the next chapter, and Make a beat's alone at the lesson", () => {
    expect(wrapUpPointers("track", 1, [])).toEqual([
      'Chapter 3 of "Finish a track", "Chords and hook": a four-bar chord loop, and a plucked hook over it',
    ]);
    expect(wrapUpPointers("beat", 0, [])[0]).toMatch(/^The "Finish a track" lesson/);
    // Begun already: it is not offered again.
    expect(wrapUpPointers("beat", 0, ["bass-key"]).join(" ")).not.toMatch(
      /Finish a track/,
    );
  });

  it("leaves a song it cannot find anything to teach in alone", () => {
    const world = beatMade();
    const end = walk(trackStart(world), world).world;
    const project: Project = { ...end.project, song: { ...end.project.song } };
    // Only Make a beat and the key ever pass over: the rest is always taught.
    expect(startLesson("track", null, { ...end, project }, settings)).not.toBeNull();
  });
});
