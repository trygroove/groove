import { type Accessor, createMemo } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import { clampTempo } from "../../audio/Transport";
import { type ControlSettle, createControlGesture } from "../../commands";
import { setParameter } from "../../commands/definitions/parameters";
import type { Project } from "../../domain/entities";
import { SONG_SWING, SONG_TEMPO } from "../../domain/parameters";
import type { UseEditorSessionResult } from "../composition/useEditorSession";
import {
  type LoopActionContext,
  moveLoopByBars,
  resizeLoopByBars,
  toggleLooping,
} from "./loopActions";

export interface UseSongControlsOptions {
  readonly project: Accessor<Project | null>;
  readonly session: Pick<UseEditorSessionResult, "dispatch" | "beginGesture">;
  readonly analytics: Accessor<Analytics>;
}

export interface SongControls {
  /** The song's tempo, in BPM. */
  readonly tempo: Accessor<number>;
  /** Sets the tempo, clamped to the supported range; ignores a non-number. */
  applyTempo(value: number): void;
  /** The song's swing. */
  readonly swing: Accessor<number>;
  /** One step of a swing drag. */
  swingInput(value: number): void;
  /** The end of a swing drag: one undo step and one save. */
  commitSwing(value: number, settle?: ControlSettle): void;
  /** Flips whether the transport obeys the song's loop brace. */
  toggleLoop(): void;
  /** Moves the loop brace by whole bars. */
  moveLoop(bars: number): void;
  /** Moves the loop brace's end edge by whole bars. */
  resizeLoop(bars: number): void;
}

/**
 * The song-wide controls the header and the transport keys share: tempo,
 * swing and the loop. Each is song state written through a command, so a
 * change is undoable and saved, and `useProjectAudio` mirrors it onto the
 * transport rather than this writing the transport itself.
 */
export function useSongControls(options: UseSongControlsOptions): SongControls {
  const { project, session } = options;

  // Tempo is written by a validated command (song.tempo), clamped to the
  // AUD-02 40-240 BPM supported range at this surface. The command is the only
  // path: `useProjectAudio` mirrors `song.tempo` onto the transport on every
  // project change, so a running song re-times without restarting and without
  // this surface writing the tempo a second time.
  const tempo = createMemo(() => project()?.song.tempo ?? SONG_TEMPO.defaultValue);
  const applyTempo = (value: number) => {
    if (!Number.isFinite(value)) return;
    session.dispatch(
      setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, clampTempo(value)),
    );
  };

  // Swing is song state written through the same `parameter.set` as tempo
  // (#500). A drag is one gesture, so it is one undo step and one save; the
  // first commit counts as first use of the feature.
  const swing = createMemo(() => project()?.song.swing ?? SONG_SWING.defaultValue);
  const swingGesture = createControlGesture({
    beginGesture: (gestureOptions) => session.beginGesture(gestureOptions),
    dispatch: (commands) => session.dispatch(commands),
    summary: () => "Set swing",
    command: (value) =>
      setParameter({ scope: "song", parameterId: SONG_SWING.id }, value),
  });
  const commitSwing = (value: number, settle?: ControlSettle) => {
    swingGesture.commit(value, settle);
    options.analytics().logFeatureFirstUse("swing");
  };

  // The loop is song state too (LOOP-017): the header's toggle dispatches
  // `loop.setEnabled` and `useProjectAudio` mirrors `song.loop` onto the
  // transport, so this surface never touches the transport's loop itself.
  const loopActions: LoopActionContext = {
    project,
    dispatch: (commands) => session.dispatch(commands),
    get analytics() {
      return options.analytics();
    },
  };

  return {
    tempo,
    applyTempo,
    swing,
    swingInput: swingGesture.input,
    commitSwing,
    toggleLoop: () => toggleLooping(loopActions),
    moveLoop: (bars) => moveLoopByBars(loopActions, bars),
    resizeLoop: (bars) => resizeLoopByBars(loopActions, bars),
  };
}
