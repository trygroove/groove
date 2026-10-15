/**
 * The checks of the basic production actions set (GRV-119): simple, exact
 * edits with one right answer, read off the project the proposal leaves.
 * No LLM judge; every check is a pure function of the fixture and the result.
 *
 * A case's {@link BasicAction} carries two halves, judged as two checks:
 *
 * - `target` (check 18, `exactEdit`): the edit the request asks for is
 *   there, e.g. the Hats track is muted.
 * - `allows` (check 19, `nothingElse`): what the edit may touch; everything
 *   else must be as it was (`basicActionPaths.ts`).
 *
 * Here are the builders for the arrangement, the tracks, the song and the
 * cases that should ask or undo; the instruments, effects and notes are in
 * `basicActionSoundChecks.ts`. Each takes the fixture's names (a track, a
 * clip) and resolves them against the project it is handed, so a case reads
 * as its request does.
 */
import type { NoteEvent, Project } from "../../domain/entities";
import type { ScaleId } from "../../domain/musicalKey";
import { TICKS_PER_BAR } from "../../domain/time";
import {
  added,
  addedWhere,
  anyOf,
  type BasicAction,
  bar,
  changedPaths,
  fail,
  fixtureClip,
  fixtureTrack,
  leaves,
  listed,
  NOTHING,
  notesOf,
  ordersKept,
  pass,
  placementsOn,
  same,
  trackNamed,
  trackPath,
  under,
} from "./basicActionPaths";

export { type BasicAction, changedPaths, checkNothingElse } from "./basicActionPaths";

// ---------------------------------------------------------------------------
// Arrangement and loops
// ---------------------------------------------------------------------------

/**
 * The notes a track plays, as `[tick, trigger, duration, velocity]` keys at
 * their absolute ticks: each placement's slice of its clip, looped or not.
 */
export function playedNotes(
  project: Project,
  trackId: string,
): { tick: number; key: string }[] {
  const played: { tick: number; key: string }[] = [];
  for (const placement of placementsOn(project, trackId)) {
    const clip = project.clips.find((candidate) => candidate.id === placement.clipId);
    const events = notesOf(clip);
    const end = placement.startTicks + placement.durationTicks;
    const length = clip?.lengthTicks ?? 0;
    const sound = (event: NoteEvent, tick: number) =>
      played.push({
        tick,
        key: JSON.stringify([event.trigger, event.durationTicks, event.velocity]),
      });
    if (placement.looped && length > 0) {
      const first = placement.startTicks - (placement.clipOffsetTicks % length);
      for (let base = first; base < end; base += length) {
        for (const event of events) {
          const tick = base + event.startTicks;
          if (tick >= placement.startTicks && tick < end) sound(event, tick);
        }
      }
    } else {
      for (const event of events) {
        const offset = event.startTicks - placement.clipOffsetTicks;
        if (
          offset >= 0 &&
          offset < placement.durationTicks &&
          event.startTicks < length
        ) {
          sound(event, placement.startTicks + offset);
        }
      }
    }
  }
  return played;
}

/** The notes in one bar, relative to its downbeat, sorted. */
function barNotes(
  played: readonly { tick: number; key: string }[],
  index: number,
): string {
  return JSON.stringify(
    played
      .filter(({ tick }) => Math.floor(tick / TICKS_PER_BAR) === index)
      .map(({ tick, key }) => `${tick % TICKS_PER_BAR}:${key}`)
      .sort(),
  );
}

/**
 * The track of the one-bar clip `clipName` plays it in every bar from the
 * first to bar `bars`, and nothing after: however the edit got there (a
 * looped placement, a longer clip with the notes copied, more placements).
 */
export function extendsLoop(clipName: string, bars: number): BasicAction {
  return {
    target: (before, after) => {
      const clip = fixtureClip(before, clipName);
      const loop = barNotes(playedNotes(before, clip.trackId), 0);
      const played = playedNotes(after, clip.trackId);
      const end = Math.max(
        0,
        ...placementsOn(after, clip.trackId).map((p) => p.startTicks + p.durationTicks),
      );
      if (end !== bars * TICKS_PER_BAR) {
        return fail(`The track plays to bar ${bar(end) - 1}, not bar ${bars}`);
      }
      const off = Array.from({ length: bars }, (_, index) => index).filter(
        (index) => barNotes(played, index) !== loop,
      );
      return off.length === 0
        ? pass(`"${clipName}" repeats in all ${bars} bars`)
        : fail(`Bars ${off.map((index) => index + 1).join(", ")} do not repeat the loop`);
    },
    allows: (before, after) => {
      const clip = fixtureClip(before, clipName);
      const onTrack = (entry: { trackId: string }) => entry.trackId === clip.trackId;
      return anyOf(
        under(`clips.${clip.id}`),
        addedWhere("clips", before.clips, after.clips, onTrack),
        ...placementsOn(before, clip.trackId).map((p) =>
          under(`song.placements.${p.id}`),
        ),
        addedWhere(
          "song.placements",
          before.song.placements,
          after.song.placements,
          onTrack,
        ),
      );
    },
  };
}

function onlyPlacementOf(project: Project, clipId: string) {
  const placements = project.song.placements.filter((p) => p.clipId === clipId);
  if (placements.length !== 1)
    throw new Error("The fixture places the clip more than once");
  return placements[0];
}

/**
 * The copy of `clipName`'s one placement in `after`: a new placement of the
 * clip that starts where the first ends and is as long, or failing that the
 * first new placement of the clip on its track at all.
 */
function copyOf(before: Project, after: Project, clipName: string) {
  const clip = fixtureClip(before, clipName);
  const original = onlyPlacementOf(before, clip.id);
  const end = original.startTicks + original.durationTicks;
  const fresh = after.song.placements.filter(
    (p) =>
      p.clipId === clip.id &&
      p.trackId === clip.trackId &&
      !before.song.placements.some((entry) => entry.id === p.id),
  );
  const exact = fresh.find(
    (p) => p.startTicks === end && p.durationTicks === original.durationTicks,
  );
  return { original, end, exact, copy: exact ?? fresh[0] };
}

/** A new placement of `clipName` starts where its one placement ends, as long. */
export function duplicatesAfter(clipName: string): BasicAction {
  return {
    target: (before, after) => {
      const { original, end, exact } = copyOf(before, after, clipName);
      const kept = after.song.placements.find((p) => p.id === original.id);
      if (!same(kept, original)) return fail(`Moves or removes the first "${clipName}"`);
      return exact
        ? pass(`"${clipName}" plays again from bar ${bar(end)}`)
        : fail(
            `No placement of "${clipName}" starts at bar ${bar(end)}, as long as the first`,
          );
    },
    // The one copy, and no other new placement on any track.
    allows: (before, after) => {
      const { copy } = copyOf(before, after, clipName);
      return copy ? under(`song.placements.${copy.id}`) : NOTHING;
    },
  };
}

function onlyPlacementOn(project: Project, trackName: string) {
  const placements = placementsOn(project, fixtureTrack(project, trackName).id);
  if (placements.length !== 1)
    throw new Error(`The fixture places "${trackName}" more than once`);
  return placements[0];
}

/** The track's one placement starts where it did and ends `bars` bars earlier. */
export function trimsEnd(trackName: string, bars: number): BasicAction {
  return {
    target: (before, after) => {
      const was = onlyPlacementOn(before, trackName);
      const now = after.song.placements.find((p) => p.id === was.id);
      const wanted = was.durationTicks - bars * TICKS_PER_BAR;
      if (!now) return fail(`Removes the "${trackName}" placement`);
      if (now.startTicks !== was.startTicks)
        return fail(`Moves the "${trackName}" placement`);
      return now.durationTicks === wanted
        ? pass(`"${trackName}" ends at bar ${bar(now.startTicks + wanted) - 1}`)
        : fail(
            `"${trackName}" ends at bar ${bar(now.startTicks + now.durationTicks) - 1}, not ${bar(was.startTicks + wanted) - 1}`,
          );
    },
    allows: (before) =>
      under(`song.placements.${onlyPlacementOn(before, trackName).id}.durationTicks`),
  };
}

/** The track's one placement starts at `startBar` (1-based) and is as long. */
export function movesTo(trackName: string, startBar: number): BasicAction {
  return {
    target: (before, after) => {
      const was = onlyPlacementOn(before, trackName);
      const now = after.song.placements.find((p) => p.id === was.id);
      if (!now) return fail(`Removes the "${trackName}" placement`);
      const problems: string[] = [];
      if (now.startTicks !== (startBar - 1) * TICKS_PER_BAR) {
        problems.push(`starts at bar ${bar(now.startTicks)}`);
      }
      if (now.durationTicks !== was.durationTicks) problems.push("changes its length");
      return problems.length === 0
        ? pass(`"${trackName}" starts at bar ${startBar}, as long as it was`)
        : fail(`"${trackName}" ${problems.join(" and ")}`);
    },
    allows: (before) =>
      under(`song.placements.${onlyPlacementOn(before, trackName).id}.startTicks`),
  };
}

/** The song's loop is on and runs from bar `first` to the end of bar `last`. */
export function loopsBars(first: number, last: number): BasicAction {
  return {
    target: (_before, after) => {
      const { startTicks, endTicks, enabled } = after.song.loop;
      const wanted =
        startTicks === (first - 1) * TICKS_PER_BAR && endTicks === last * TICKS_PER_BAR;
      if (!wanted) {
        return fail(`The loop runs bars ${bar(startTicks)} to ${bar(endTicks) - 1}`);
      }
      return enabled
        ? pass(`The loop runs bars ${first} to ${last}`)
        : fail("The loop is off");
    },
    allows: () => under("song.loop"),
  };
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** The track, its clips and its placements are gone. */
export function deletesTrack(trackName: string): BasicAction {
  const owned = (project: Project) => {
    const track = fixtureTrack(project, trackName);
    return {
      track,
      clips: project.clips.filter((clip) => clip.trackId === track.id),
      placements: placementsOn(project, track.id),
    };
  };
  return {
    target: (before, after) => {
      const { track, clips, placements } = owned(before);
      if (after.song.tracks.some((entry) => entry.id === track.id)) {
        return fail(`"${trackName}" is still there`);
      }
      const left =
        after.clips.filter((clip) => clips.some((entry) => entry.id === clip.id)).length +
        after.song.placements.filter((p) => placements.some((entry) => entry.id === p.id))
          .length;
      return left === 0
        ? pass(`"${trackName}" is gone with its clips`)
        : fail(`"${trackName}" left ${left} clips or placements behind`);
    },
    allows: (before, after) => {
      const { track, clips, placements } = owned(before);
      return anyOf(
        ordersKept("song.tracks", before.song.tracks, after.song.tracks),
        under(
          `song.tracks.${track.id}`,
          ...clips.map((clip) => `clips.${clip.id}`),
          ...placements.map((p) => `song.placements.${p.id}`),
        ),
      );
    },
  };
}

/** Exactly one new track, playing a `kind` instrument. */
export function addsTrackOf(kind: "synth" | "drumMachine"): BasicAction {
  return {
    target: (before, after) => {
      const existing = new Set<string>(before.song.tracks.map((track) => track.id));
      const fresh = after.song.tracks.filter((track) => !existing.has(track.id));
      if (fresh.length !== 1) return fail(`Adds ${fresh.length} tracks, not one`);
      const [track] = fresh;
      return track.instrument?.kind === kind
        ? pass(`Adds "${track.name}", a ${kind}`)
        : fail(
            `Adds "${track.name}" with ${track.instrument?.kind ?? "no"} instrument, not a ${kind}`,
          );
    },
    // The new track, and clips and placements on it; the tracks there were
    // may be renumbered around it but keep their order.
    allows: (before, after) => {
      const existing = new Set<string>(before.song.tracks.map((track) => track.id));
      const onNewTrack = (entry: { trackId: string }) => !existing.has(entry.trackId);
      return anyOf(
        ordersKept("song.tracks", before.song.tracks, after.song.tracks),
        added("song.tracks", existing),
        addedWhere("clips", before.clips, after.clips, onNewTrack),
        addedWhere(
          "song.placements",
          before.song.placements,
          after.song.placements,
          onNewTrack,
        ),
      );
    },
  };
}

/** The track at `position` (1-based, in the order they are listed) is named `name`. */
export function renamesTrack(position: number, name: string): BasicAction {
  const at = (project: Project) =>
    [...project.song.tracks].sort((a, b) => a.order - b.order)[position - 1];
  return {
    target: (before, after) => {
      const id = at(before).id;
      const now = after.song.tracks.find((track) => track.id === id);
      return now?.name === name
        ? pass(`Track ${position} is "${name}"`)
        : fail(`Track ${position} is "${now?.name ?? "gone"}", not "${name}"`);
    },
    allows: (before) => under(`song.tracks.${at(before).id}.name`),
  };
}

/** The track's mute or solo is on. */
export function setsFlag(trackName: string, flag: "muted" | "soloed"): BasicAction {
  return {
    target: (_before, after) =>
      trackNamed(after, trackName)?.mixer[flag]
        ? pass(`"${trackName}" is ${flag}`)
        : fail(`"${trackName}" is not ${flag}`),
    allows: (before) => under(`${trackPath(before, trackName)}.mixer.${flag}`),
  };
}

/** The track is listed first, and the rest keep their order. */
export function movesToTop(trackName: string): BasicAction {
  return {
    target: (before, after) => {
      const id = fixtureTrack(before, trackName).id;
      const was = listed(before.song.tracks);
      const now = listed(after.song.tracks);
      const wanted = [id, ...was.filter((entry) => entry !== id)];
      return same(now, wanted)
        ? pass(`"${trackName}" is at the top; the rest keep their order`)
        : fail(
            now[0] === id
              ? "The other tracks moved too"
              : `"${trackName}" is not at the top`,
          );
    },
    allows: (before, after) =>
      ordersKept(
        "song.tracks",
        before.song.tracks,
        after.song.tracks,
        new Set([fixtureTrack(before, trackName).id]),
      ),
  };
}

/** The track's volume moved by `deltaDb`, within `tolerance`. */
export function changesVolumeBy(
  trackName: string,
  deltaDb: number,
  tolerance = 0.1,
): BasicAction {
  return {
    target: (before, after) => {
      const was = fixtureTrack(before, trackName).mixer.volume;
      const now = trackNamed(after, trackName)?.mixer.volume ?? Number.NaN;
      const moved = now - was;
      return Math.abs(moved - deltaDb) <= tolerance
        ? pass(`"${trackName}" moved ${moved.toFixed(2)} dB`)
        : fail(`"${trackName}" moved ${moved.toFixed(2)} dB, not ${deltaDb} dB`);
    },
    allows: (before) => under(`${trackPath(before, trackName)}.mixer.volume`),
  };
}

/** The track is panned left of centre. */
export function pansLeft(trackName: string): BasicAction {
  return {
    target: (_before, after) => {
      const pan = trackNamed(after, trackName)?.mixer.pan ?? 0;
      return pan < 0
        ? pass(`"${trackName}" pans ${pan.toFixed(2)}`)
        : fail(`"${trackName}" pans ${pan.toFixed(2)}, not left`);
    },
    allows: (before) => under(`${trackPath(before, trackName)}.mixer.pan`),
  };
}

// ---------------------------------------------------------------------------
// Song-wide
// ---------------------------------------------------------------------------

export function setsTempo(bpm: number): BasicAction {
  return {
    target: (_before, after) =>
      after.song.tempo === bpm
        ? pass(`${bpm} BPM`)
        : fail(`${after.song.tempo} BPM, not ${bpm}`),
    allows: () => under("song.tempo"),
  };
}

export function setsKey(root: number, scale: ScaleId): BasicAction {
  return {
    target: (_before, after) =>
      after.song.key.root === root && after.song.key.scale === scale
        ? pass(`The key is ${root} ${scale}`)
        : fail(
            `The key is ${after.song.key.root} ${after.song.key.scale}, not ${root} ${scale}`,
          ),
    allows: () => under("song.key"),
  };
}

// ---------------------------------------------------------------------------
// Asking instead of guessing
// ---------------------------------------------------------------------------

/**
 * Everything the last change moved is back as it was in `previous`, the
 * project before it. Anything else that moved is `nothingElse`'s to find.
 */
export function restores(previous: () => Project): BasicAction {
  return {
    target: (before, after) => {
      const was = leaves(previous());
      const now = leaves(after);
      const left = changedPaths(previous(), before).filter(
        (path) => was.get(path) !== now.get(path),
      );
      return left.length === 0
        ? pass("The last change is undone")
        : fail(`Not undone: ${left.slice(0, 3).join(", ")}`);
    },
    allows: (before) => {
      const reverted = new Set(changedPaths(previous(), before));
      return (path) => reverted.has(path);
    },
  };
}

/** Any proposal is wrong: the request names nothing the project has. */
export function proposesNothing(reason: string): BasicAction {
  return {
    target: () => fail(`Proposed a change, but ${reason}`),
    allows: () => NOTHING,
  };
}
