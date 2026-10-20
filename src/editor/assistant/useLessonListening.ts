/**
 * What "Finish a track" listens for in the editor (GRV-44), as a lesson's
 * world reads it: the bar the playhead is in, how many bars the song has
 * moved through and how many times the master meter has gone red since it
 * last started playing, and how many stem exports have been started.
 *
 * The transport and the meters are the editor's; this only counts, so a
 * step's predicate stays a pure function of the world it is handed.
 */
import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import { TICKS_PER_BAR } from "../../domain/time";
import type { ExportFormat } from "../export/FormatCards";
import type { TrackLevel } from "../trackLevels";
import type { LessonListening } from "./useLesson";

export interface UseLessonListeningOptions {
  readonly playing: Accessor<boolean>;
  readonly positionTicks: Accessor<number>;
  readonly masterLevel: Accessor<TrackLevel | null>;
}

export interface LessonListeningCounts extends LessonListening {
  /** Hears that Export was pressed in the dialog, in `format`. */
  exported(format: ExportFormat): void;
}

export function useLessonListening(
  options: UseLessonListeningOptions,
): LessonListeningCounts {
  const bar = createMemo(() => Math.floor(options.positionTicks() / TICKS_PER_BAR));
  const [barsHeard, setBarsHeard] = createSignal(0);
  const [masterClips, setMasterClips] = createSignal(0);
  const [stemExports, setStemExports] = createSignal(0);

  // Stopping clears the counts, so a song that starts playing again starts
  // from none: cleared on the stop rather than the start, so a lesson step
  // that reads them as the song starts never sees the last play's. A new bar
  // while playing adds one. The reads are in the compute half; counting
  // writes, in the apply.
  // The loop brace sending the playhead back counts as a bar too, so a
  // one-bar loop still adds up.
  let wasPlaying = false;
  let lastBar = 0;
  let lastTicks = 0;
  createEffect(
    () => ({ playing: options.playing(), at: bar(), ticks: options.positionTicks() }),
    ({ playing, at, ticks }) => {
      if (!playing && wasPlaying) {
        setBarsHeard(0);
        setMasterClips(0);
      } else if (playing && wasPlaying && (at !== lastBar || ticks < lastTicks)) {
        setBarsHeard((heard) => heard + 1);
      }
      wasPlaying = playing;
      lastBar = at;
      lastTicks = ticks;
    },
  );

  // The meter going red while the song plays is one clip, however long it
  // stays lit.
  let wasClipping = false;
  createEffect(
    () => ({
      clipping: options.masterLevel()?.clipping ?? false,
      playing: options.playing(),
    }),
    ({ clipping, playing }) => {
      if (clipping && !wasClipping && playing) setMasterClips((clips) => clips + 1);
      wasClipping = clipping;
    },
  );

  return {
    bar,
    barsHeard,
    masterClips,
    stemExports,
    exported(format) {
      if (format === "stems") setStemExports((count) => count + 1);
    },
  };
}
