/**
 * The editor's side of a question's options (GRV-42): what hovering, picking
 * and hearing an option does to the song on screen. One per editor, handed
 * to the assistant's chat as its {@link AskEditorLink}.
 *
 * - A hovered reference is drawn on the arrangement as bands (`bands`).
 * - A picked reference becomes the selection: the track pointed at, the
 *   clips selected.
 * - A track's sound is one note through its instrument; a preview opens the
 *   session's preview of the option's changes (UI-005) and plays the song
 *   from where it is, until the pointer leaves, when the preview is put away
 *   and a song it started is paused back where it was. Nothing is applied.
 *   Neither a hover nor Space puts away a preview something else opened (an
 *   assistant proposal's, say): that preview's owner is showing it, and only
 *   it knows to put its own state back when it ends.
 */
import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import type { AskReference, AskSound } from "../../assistant/ask";
import type { Project } from "../../domain/entities";
import type { TrackId } from "../../domain/ids";
import { TICKS_PER_QUARTER } from "../../domain/time";
import type { ArrangementBand, ArrangementSelection } from "../../selection";
import type { Preview } from "../sessionPreview";
import type { UseEditorSessionResult } from "../useEditorSession";
import type { ProjectAudioControls } from "../useProjectAudio";
import {
  type AskEditorLink,
  auditionTrigger,
  canHearIn,
  previewCommands,
  referenceBands,
  referenceLabel,
  referenceSelection,
  resolveTrack,
} from "./askReferences";

export interface UseAskEditorLinkOptions {
  /** What the editor shows. */
  readonly project: Accessor<Project | null>;
  readonly session: Pick<
    UseEditorSessionResult,
    "beginPreview" | "committedProject" | "previewOpen"
  >;
  readonly audio: Pick<
    ProjectAudioControls,
    "isPlaying" | "play" | "pause" | "positionTicks" | "seekTicks" | "auditionTrack"
  >;
  /** Points the editor at a track. */
  selectTrack(trackId: TrackId): void;
  /** Makes clips the arrangement's selection. */
  selectArrangement(selection: ArrangementSelection): void;
  /**
   * Whether the page may start sound without a click of its own: the
   * producer has interacted with it already. A hover is not a gesture, so a
   * sound on hover waits until then (an option's Space still works).
   */
  readonly mayStartSound?: () => boolean;
}

export interface AskEditorLinkHandle extends AskEditorLink {
  /** The bands the hovered option's reference draws on the arrangement. */
  readonly bands: Accessor<readonly ArrangementBand[]>;
}

/** What the browser says about the page having been interacted with. */
function pageHasBeenActive(): boolean {
  const activation = (navigator as { userActivation?: { hasBeenActive: boolean } })
    .userActivation;
  return activation?.hasBeenActive ?? true;
}

export function useAskEditorLink(options: UseAskEditorLinkOptions): AskEditorLinkHandle {
  const [highlighted, setHighlighted] = createSignal<AskReference | null>(null);
  const bands = createMemo((): readonly ArrangementBand[] => {
    const ref = highlighted();
    const project = options.project();
    return ref && project ? referenceBands(project, ref) : [];
  });
  /** What {@link hear} started, so {@link stopHearing} can undo it. */
  let hearing: {
    readonly preview: Preview | null;
    readonly startedSong: boolean;
    readonly from: number;
  } | null = null;
  const committed = () => options.session.committedProject() ?? options.project();
  const mayStartSound = options.mayStartSound ?? pageHasBeenActive;

  function stopHearing(): void {
    const ending = hearing;
    hearing = null;
    if (!ending) return;
    ending.preview?.cancel();
    if (ending.startedSong) {
      options.audio.pause();
      options.audio.seekTicks(ending.from);
    }
  }

  function hear(sound: AskSound, gesture = false): void {
    stopHearing();
    const project = committed();
    if (!project || (!gesture && !mayStartSound())) return;
    if (sound.kind === "track") {
      const track = resolveTrack(project, sound.trackId);
      const trigger = track && auditionTrigger(track);
      if (track && trigger) {
        void options.audio.auditionTrack(track.id, trigger, TICKS_PER_QUARTER, 0.8);
      }
      return;
    }
    // `stopHearing` put away any preview of ours, so one still open is
    // someone else's.
    if (options.session.previewOpen()) return;
    const commands = previewCommands(project, sound);
    const opened = commands && options.session.beginPreview(commands);
    if (!opened?.ok) return;
    const playing = options.audio.isPlaying();
    hearing = {
      preview: opened.preview,
      startedSong: !playing,
      from: options.audio.positionTicks(),
    };
    if (!playing) void options.audio.play();
  }

  onCleanup(stopHearing);

  return {
    bands,
    highlight: (ref) => setHighlighted(ref),
    select(ref) {
      const project = committed();
      if (!project) return;
      const target = referenceSelection(project, ref);
      if (target.trackId) options.selectTrack(target.trackId);
      if (target.arrangement) options.selectArrangement(target.arrangement);
    },
    canHear(sound) {
      const project = committed();
      return project !== null && canHearIn(project, sound);
    },
    hear,
    stopHearing,
    describe(ref) {
      const project = options.project();
      return project ? referenceLabel(project, ref) : null;
    },
  };
}
