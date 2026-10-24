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
import type { LoopRange } from "../../audio/loopRange";
import type { Project } from "../../domain/entities";
import { TICKS_PER_BAR } from "../../domain/time";
import type { LessonWorld } from "../../lessons/types";
import type { EditorViewName } from "../composition/editorViews";
import type { ExportFormat } from "../export/FormatCards";
import type { TrackLevel } from "../tracks/trackLevels";

/** What the editor reports to "Finish a track" (GRV-44), each an accessor. */
export interface LessonListening {
  readonly bar: Accessor<number>;
  readonly barsHeard: Accessor<number>;
  readonly masterClips: Accessor<number>;
  readonly stemExports: Accessor<number>;
}

/**
 * The world a lesson's step is read against, as the editor stands now: the
 * project, the view, the transport, and what `listening` counts (0 without
 * it). Null while no project is open. Every read is reactive.
 */
export function lessonWorld(
  project: Project | null,
  view: EditorViewName,
  playing: boolean,
  listening?: LessonListening,
): LessonWorld | null {
  return project
    ? {
        project,
        view,
        playing,
        bar: listening?.bar() ?? 0,
        barsHeard: listening?.barsHeard() ?? 0,
        masterClips: listening?.masterClips() ?? 0,
        stemExports: listening?.stemExports() ?? 0,
      }
    : null;
}

export interface UseLessonListeningOptions {
  readonly playing: Accessor<boolean>;
  readonly positionTicks: Accessor<number>;
  readonly masterLevel: Accessor<TrackLevel | null>;
  /** The loop the transport obeys, or null while it is off. */
  readonly loop?: Accessor<LoopRange | null>;
}

/**
 * Whether the playhead moving from `from` back to `to` ticks is `loop` going
 * round: from its last bar to its first, not a seek back.
 */
export function loopWrapped(loop: LoopRange | null, from: number, to: number): boolean {
  return (
    loop !== null &&
    to < from &&
    from >= loop.endTicks - TICKS_PER_BAR &&
    to >= loop.startTicks &&
    to < loop.startTicks + TICKS_PER_BAR
  );
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
  // The loop going round counts as a bar too, even inside one bar, so a
  // one-bar loop still adds up; a seek back within a bar does not.
  let wasPlaying = false;
  let lastBar = 0;
  let lastTicks = 0;
  createEffect(
    () => ({
      playing: options.playing(),
      at: bar(),
      ticks: options.positionTicks(),
      loop: options.loop?.() ?? null,
    }),
    ({ playing, at, ticks, loop }) => {
      if (!playing && wasPlaying) {
        setBarsHeard(0);
        setMasterClips(0);
      } else if (
        playing &&
        wasPlaying &&
        (at !== lastBar || loopWrapped(loop, lastTicks, ticks))
      ) {
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
