import { createSignal, createStore } from "solid-js";
import type { LevelReading } from "../audio/levels";
import type { TrackId } from "../domain/ids";

/**
 * What a track's meter shows (#447): the RMS its bar is filled to, and
 * whether it is clipping — a peak over 0 dBFS, held for a moment so a single
 * over is seen rather than lost between two frames.
 */
export interface TrackLevel {
  readonly db: number;
  readonly clipping: boolean;
}

/** Frames a clip stays lit after the last over: about 0.75 s at 60 Hz. */
export const CLIP_HOLD_FRAMES = 45;

/**
 * One frame of a track's meter from its reading and the frames of clip hold
 * left, returning the level to show and the hold to carry to the next frame.
 */
export function nextTrackLevel(
  reading: LevelReading,
  holdLeft: number,
): { readonly level: TrackLevel; readonly holdLeft: number } {
  const hold = reading.peakDb > 0 ? CLIP_HOLD_FRAMES : Math.max(0, holdLeft - 1);
  return { level: { db: reading.rmsDb, clipping: hold > 0 }, holdLeft: hold };
}

/**
 * Every track's meter, as one store the editor's frame loop feeds (#447):
 * `sample` takes one frame of the graph's readings, `clear` rests every meter,
 * and `level` is what a meter reads, reactively. A meter that did not change
 * this frame is not written, so a quiet track costs its meter nothing.
 */
export function createTrackLevels() {
  const [levels, setLevels] = createStore<Record<string, TrackLevel>>({});
  const holds = new Map<TrackId, number>();
  return {
    level(trackId: TrackId): TrackLevel | null {
      return levels[trackId] ?? null;
    },
    sample(readings: ReadonlyMap<TrackId, LevelReading>): void {
      setLevels((draft) => {
        for (const id of Object.keys(draft)) {
          if (!readings.has(id as TrackId)) delete draft[id];
        }
        for (const [trackId, reading] of readings) {
          const next = nextTrackLevel(reading, holds.get(trackId) ?? 0);
          holds.set(trackId, next.holdLeft);
          const current = draft[trackId];
          if (
            current?.db !== next.level.db ||
            current?.clipping !== next.level.clipping
          ) {
            draft[trackId] = next.level;
          }
        }
      });
    },
    clear(): void {
      holds.clear();
      setLevels((draft) => {
        for (const id of Object.keys(draft)) delete draft[id];
      });
    },
  };
}

/**
 * The master's meter (GRV-44): the same frame rule as a track's, for the one
 * strip that is not a track. `sample` takes the master's reading for a frame,
 * `clear` rests it, and `level` is what the master meter reads, reactively.
 */
export function createMasterLevel() {
  const [level, setLevel] = createSignal<TrackLevel | null>(null);
  let hold = 0;
  // What was last written, so an unchanged frame writes nothing.
  let shown: TrackLevel | null = null;
  const show = (next: TrackLevel | null) => {
    if (next?.db === shown?.db && next?.clipping === shown?.clipping) return;
    shown = next;
    setLevel(next);
  };
  return {
    level,
    sample(reading: LevelReading): void {
      const next = nextTrackLevel(reading, hold);
      hold = next.holdLeft;
      show(next.level);
    },
    clear(): void {
      hold = 0;
      show(null);
    },
  };
}
