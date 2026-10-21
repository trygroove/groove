import { describe, expect, it } from "vitest";
import type { Project } from "../domain/entities";
import { TICKS_PER_BAR } from "../domain/time";
import { applyShowMe, lessonContext, starterWorld } from "../testing/lessonWorld";
import { chapter } from "./chapters";
import { cueMessage, lessonCue, wrapUpPointers } from "./cue";
import { BITE_IDS, TRACK_CHAPTER_IDS, TRACK_UNDER_WAY } from "./ids";
import {
  biteOf,
  chapterFinished,
  type LessonState,
  type LessonTransition,
  observe,
  resumeLesson,
  skip,
  startBite,
  startNextBite,
  startTrack,
} from "./session";
import {
  madeBites,
  TRACK_CHAPTERS,
  trackChapterNumber,
  trackProgress,
  trackResume,
  withTrackUnderWay,
} from "./track";
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
    if (chapterFinished(state) && !state.track) break;
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

describe("Finish a track (GRV-44)", () => {
  it("is five chapters, from a beat to stems", () => {
    expect(TRACK_CHAPTERS.map((one) => one.title)).toEqual([
      "Make a beat",
      "Bass",
      "Chords and hook",
      "Arrange, subtractively",
      "Mix and export",
    ]);
    expect(TRACK_CHAPTER_IDS.map(trackChapterNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it("is under way once a bite only it teaches is done, and picks up at the first left", () => {
    expect(trackResume([])).toBeNull();
    // Make a beat is taught alone too: its bites say nothing about this lesson.
    expect(trackResume(["beat-library", "beat-kick"])).toBeNull();
    expect(trackResume(["bass-key", "bass-line", "bass-sound", "chords-loop"])).toEqual({
      chapter: "chords",
      biteId: "chords-hook",
    });
    const own = BITE_IDS.filter((id) => !/^(beat|sound|tour)-/.test(id));
    expect(trackResume(own)).toBeNull();
  });

  it("is under way from its first bite once started, Make a beat included", () => {
    const started = withTrackUnderWay([]);
    expect(started).toEqual([TRACK_UNDER_WAY]);
    expect(withTrackUnderWay(started)).toEqual(started);
    expect(trackResume(started)).toEqual({ chapter: "beat", biteId: "beat-library" });
    // Part-way through the beat: the next beat bite, inside this lesson.
    expect(trackResume([...started, "beat-library", "beat-kick"])).toEqual({
      chapter: "beat",
      biteId: "beat-play",
    });
    // The beat done and Bass not started: chapter 2.
    const beat = BITE_IDS.filter((id) => id.startsWith("beat-"));
    expect(trackResume([...started, ...beat])).toEqual({
      chapter: "bass",
      biteId: "bass-key",
    });
    // Once past the beat, a beat bite left undone is not gone back to.
    expect(trackResume([...started, "bass-key"])).toEqual({
      chapter: "bass",
      biteId: "bass-line",
    });
    const own = BITE_IDS.filter((id) => !/^(beat|sound|tour)-/.test(id));
    expect(trackResume([...started, ...own])).toBeNull();
  });

  it("picks up after the furthest bite done, a bite skipped on the way not offered again", () => {
    // "Round it off" skipped (skips are not saved), the rest done through the intro.
    const done = withTrackUnderWay([
      "bass-key",
      "bass-line",
      "chords-loop",
      "chords-hook",
      "chords-pluck",
      "arrange-copy",
      "arrange-intro",
    ]);
    expect(trackResume(done)).toEqual({
      chapter: "arrange",
      biteId: "arrange-breakdown",
    });
    expect(trackProgress(done)).toEqual(done);
    // Once the last bite is done the lesson is over, a bite skipped or not.
    const finished = [...done, "arrange-breakdown", "arrange-drop", "mix-export"];
    expect(trackResume(finished)).toBeNull();
    expect(trackProgress(finished)).toEqual([]);
  });

  it("passes over what the producer has done when they go back, and goes on from where they are", () => {
    const beat = walk(
      startBite("beat", "beat-kick", starterWorld(), settings),
      starterWorld(),
    );
    const done = withTrackUnderWay([
      "bass-key",
      "bass-line",
      "chords-loop",
      "chords-hook",
    ]);
    const progress = trackProgress(done);
    // Back to Bass for the bite skipped: only that one is taught there.
    const back = startTrack("bass", "bass-sound", beat.world, settings, [], progress);
    if (!back) throw new Error("not started");
    expect(biteOf(back.state).id).toBe("bass-sound");
    expect(back.state.behind).toEqual(["bass-key", "bass-line"]);
    expect(back.event).toEqual({ kind: "bite_started", passed: [] });
    const sounded = skipBite(back.state, beat.world);
    expect(sounded.event).toMatchObject({ chapterDone: true, trackDone: false });
    // On to the chords: the loop and the hook are done, so the pluck is next,
    // and nothing is told as already in the song.
    const next = startNextBite(sounded.state, beat.world, settings, progress);
    expect(next && biteOf(next.state).id).toBe("chords-pluck");
    expect(next?.event).toEqual({ kind: "bite_started", passed: [] });
    // A chapter's bites done are passed over inside it as well.
    const loop = startTrack("chords", "chords-loop", beat.world, settings, [], progress);
    if (!loop) throw new Error("not started");
    const looped = skipBite(loop.state, beat.world);
    const after = startNextBite(looped.state, beat.world, settings, progress);
    expect(after && biteOf(after.state).id).toBe("chords-pluck");
    // Not under way, nothing is passed over for being done: it is taught again.
    expect(
      startTrack("bass", null, beat.world, settings, [], trackProgress([])),
    ).toMatchObject({ state: { behind: [] } });
  });

  it("passes over the kick the starter already plays, and teaches the rest of the beat", () => {
    const world = starterWorld();
    expect(madeBites("beat", world, settings)).toEqual(["beat-kick"]);
    const started = startTrack("beat", null, world, settings);
    expect(started && biteOf(started.state).id).toBe("beat-library");
    expect(started?.state.track).toBe(true);
    expect(started?.event).toEqual({ kind: "bite_started", passed: [] });
    if (!started) throw new Error("not started");
    // Picking a kick is taught; the kick's own bite is passed over when it comes.
    const picked = skip(started.state, world, settings);
    if (!picked) throw new Error("not skipped");
    expect(picked.event).toMatchObject({ kind: "bite_done", chapterDone: false });
    const next = startNextBite(picked.state, world, settings);
    expect(next && biteOf(next.state).id).toBe("beat-play");
    expect(next?.event).toEqual({ kind: "bite_started", passed: ["beat-kick"] });
  });

  it("passes the whole beat over in a song that has one, and starts on the bass", () => {
    const beat = walk(
      startBite("beat", "beat-kick", starterWorld(), settings),
      starterWorld(),
    );
    const started = startTrack("beat", null, beat.world, settings);
    expect(started && biteOf(started.state).id).toBe("bass-key");
    expect(started?.event).toEqual({
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
    if (!started) throw new Error("not started");
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
    const beat = walk(
      startBite("beat", "beat-kick", starterWorld(), settings),
      starterWorld(),
    );
    const started = startTrack("beat", null, beat.world, settings);
    if (!started) throw new Error("not started");
    const run = walk(started, beat.world);

    expect(run.bites).toEqual(BITE_IDS.filter((id) => !/^(beat|sound|tour)-/.test(id)));
    const ends = run.events.filter((event) => event.kind === "bite_done");
    expect(ends.filter((event) => event.chapterDone)).toHaveLength(4);
    expect(ends.at(-1)).toMatchObject({ chapterDone: true, trackDone: true });
    expect(ends.filter((event) => event.trackDone)).toHaveLength(1);

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

  it("comes back after a reload as itself: a chapter over waits on the next (GRV-43)", () => {
    const world = starterWorld();
    const bass = chapter("bass").bites.map((one) => one.id);
    const last = bass[bass.length - 1];
    const endings = Object.fromEntries(bass.map((id) => [id, "did_it" as const]));
    const course = { track: true, passed: [bass[0]] };

    const under = resumeLesson("bass", bass[1], world, settings, {}, course);
    expect(under).toMatchObject({ track: true, passed: [bass[0]] });
    expect(under?.step).not.toBeNull();

    const over = resumeLesson("bass", last, world, settings, endings, course);
    expect(over).toMatchObject({ chapter: "bass", track: true, step: null });
    const next = over && startNextBite(over, world, settings);
    expect(next?.state).toMatchObject({ chapter: "chords", track: true });

    // Alone, the same chapter had ended; the track's last chapter ends it.
    expect(resumeLesson("bass", last, world, settings, endings)).toBeNull();
    expect(
      resumeLesson(
        "mix",
        "mix-export",
        world,
        settings,
        { "mix-export": "did_it" },
        course,
      ),
    ).toBeNull();
  });

  it("ends with the track: the last bite's cue is its wrap-up", () => {
    const world = starterWorld();
    const started = startBite("mix", "mix-export", world, settings);
    const state = { ...started.state, track: true };
    const ended = observe(state, { ...world, stemExports: 1 }, settings);
    if (!ended) throw new Error("not ended");
    expect(ended.event).toMatchObject({
      kind: "bite_done",
      chapterDone: true,
      trackDone: true,
    });
    const cue = lessonCue(ended.state, ended.event, settings, []);
    expect(cue.moment).toBe("track_done");
    expect(cue.next.length).toBeGreaterThan(0);
    expect(cueMessage(ended.state, ended.event)).toMatch(/last bite of "Finish a track"/);
    expect(startNextBite(ended.state, world, settings)).toBeNull();
  });

  it("points a chapter's wrap-up at the next chapter, and Make a beat's alone at the lesson", () => {
    expect(wrapUpPointers("bass", [], true)).toEqual([
      'Chapter 3 of "Finish a track", "Chords and hook": a four-bar chord loop, and a plucked hook over it',
    ]);
    expect(wrapUpPointers("beat", [])[0]).toMatch(/^The "Finish a track" lesson/);
    // Under way already: it is not offered again.
    expect(wrapUpPointers("beat", ["bass-key"]).join(" ")).not.toMatch(/Finish a track/);
  });

  it("leaves a song it cannot find anything to teach in alone", () => {
    const beat = walk(
      startBite("beat", "beat-kick", starterWorld(), settings),
      starterWorld(),
    );
    const done = startTrack("beat", null, beat.world, settings);
    if (!done) throw new Error("not started");
    const end = walk(done, beat.world).world;
    const project: Project = { ...end.project, song: { ...end.project.song } };
    // Only Make a beat and the key ever pass over: the rest is always taught.
    expect(startTrack("bass", null, { ...end, project }, settings)).not.toBeNull();
  });
});
