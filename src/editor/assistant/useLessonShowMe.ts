/**
 * Show me (GRV-43): what a lesson's step does in the editor when the
 * producer asks to be shown, through the editor as the assistant: commands as
 * one undoable change, a view switch, Play, the Export dialog, or a library
 * sound on a pad. A step whose Show me only opens where to act (the Export
 * dialog, GRV-44) opens it as the step starts.
 *
 * While a step is under way its control wears the dashed proposal mark
 * (`UI-004`), and what it belongs to is selected, so the view the step names
 * opens on it.
 *
 * Show me is marked on the step before the editor acts, so the change it
 * makes is read as Show me's; when the editor could not act, the mark is
 * taken back, so a producer who then does the step by hand is credited with
 * it, and a notice says what happened.
 */
import { type Accessor, createEffect, createSignal, untrack } from "solid-js";
import type { ControlAddress } from "../../commands/controlAddress";
import type { RawCommandInput } from "../../commands/types";
import type { ControlRegistry } from "../../controls/registry";
import type { DomainFactoryContext } from "../../domain/factories";
import type { PadId, TrackId } from "../../domain/ids";
import { biteOf, type LessonState, markShown } from "../../lessons/session";
import type { LessonSettings, LessonWorld, ShowMe } from "../../lessons/types";
import type { EditorViewName } from "../composition/editorViews";

/** What Show me does in the editor. */
export interface LessonEditorPort {
  /** Applies commands as one undoable change by the assistant; whether it did. */
  apply(commands: readonly RawCommandInput[]): boolean;
  goTo(view: EditorViewName): void;
  /**
   * Selects what a step acts on (its track, pad and clip) without changing
   * the view, so the view the step names opens on it.
   */
  point(address: ControlAddress): void;
  /**
   * Starts the song, from `from` ticks when given; settles once it plays or
   * could not start.
   */
  play(from?: number): Promise<void>;
  /** Opens the Export dialog with stems chosen and every track in them (GRV-44). */
  openExport(): void;
  /** Puts a library sound of `role` on the pad, as the Library's Insert; whether it did. */
  putSound(role: "kick", trackId: TrackId, padId: PadId): Promise<boolean>;
}

/** What Show me says when it has nothing to do. */
export const NOTHING_TO_SHOW = "There's nothing to show here: this step is already done.";
/** What Show me says when the change would not go in. */
export const SHOW_ME_FAILED = "That didn't go in. Try it by hand, or press Skip.";
/** What Show me says when the library has no other kick to offer. */
export const NO_SOUND =
  "I couldn't find another kick in the library. Pick one by hand, or press Skip.";

/**
 * How long Show me waits for the view it asked for before deciding it did
 * not open, and taking its mark back.
 */
export const SHOW_ME_SETTLE_MS = 1000;

export interface UseLessonShowMeOptions {
  readonly state: Accessor<LessonState | null>;
  /** Writes the lesson's state; the updater form sees a write not yet flushed. */
  readonly setState: (
    next: LessonState | null | ((now: LessonState | null) => LessonState | null),
  ) => void;
  readonly world: () => LessonWorld | null;
  readonly settings: Accessor<LessonSettings>;
  readonly view: Accessor<EditorViewName>;
  readonly playing: Accessor<boolean>;
  /** Without one, Show me has nothing to do. */
  readonly editor?: LessonEditorPort;
  /** Where the step's control is marked. */
  readonly registry?: Pick<ControlRegistry, "setMark">;
  readonly factory: () => DomainFactoryContext;
}

export interface LessonShowMe {
  /** A word after Show me could not do anything. */
  readonly notice: Accessor<string | null>;
  clearNotice(): void;
  showMe(): void;
  /** A step just started: one whose Show me only opens where to act opens it now. */
  arrive(next: LessonState): void;
}

export function useLessonShowMe(options: UseLessonShowMeOptions): LessonShowMe {
  const [notice, setNotice] = createSignal<string | null>(null);

  // Where to act wears the dashed mark while its step is under way, and is
  // selected. The target is read off the world the step started in, so it
  // holds still.
  createEffect(
    () => {
      const current = options.state();
      if (!current?.step) return null;
      const step = biteOf(current).steps[current.step.index];
      return step.target(current.step.start, options.settings());
    },
    (address) => {
      if (!address) return;
      options.editor?.point(address);
      const registry = options.registry;
      if (!registry) return;
      registry.setMark(address, "previewed");
      return () => registry.setMark(address, "none");
    },
  );

  /** Has the editor do what Show me says, with nothing to take back. */
  function act(shown: ShowMe): void {
    const editor = options.editor;
    if (!editor) return;
    switch (shown.kind) {
      case "commands":
        editor.apply(shown.commands);
        return;
      case "view":
        editor.goTo(shown.view);
        return;
      case "play":
        void editor.play(shown.from);
        return;
      case "export":
        editor.openExport();
        return;
      case "sound":
        void editor.putSound(shown.role, shown.trackId, shown.padId);
    }
  }

  function arrive(next: LessonState): void {
    if (!next.step) return;
    const step = biteOf(next).steps[next.step.index];
    if (!step.showsAtStart) return;
    const now = options.world();
    // It is not the step done, so nothing is marked shown.
    const shown = now && step.showMe(now, untrack(options.settings), options.factory());
    if (shown) act(shown);
  }

  function showMe(): void {
    const current = options.state();
    const now = options.world();
    const editor = options.editor;
    if (!current?.step || !now || !editor) return;
    const step = biteOf(current).steps[current.step.index];
    const shown = step.showMe(now, options.settings(), options.factory());
    if (!shown) {
      setNotice(NOTHING_TO_SHOW);
      return;
    }
    setNotice(null);
    const marked = markShown(current);
    options.setState(marked);
    const unmark = () =>
      options.setState((state) => (state === marked ? current : state));
    switch (shown.kind) {
      case "commands":
        if (!editor.apply(shown.commands)) {
          unmark();
          setNotice(SHOW_ME_FAILED);
        }
        return;
      case "view":
        editor.goTo(shown.view);
        // A view that never opens is no Show me: the producer who then goes
        // there by hand did it themselves.
        setTimeout(() => {
          if (untrack(options.view) !== shown.view) unmark();
        }, SHOW_ME_SETTLE_MS);
        return;
      case "play":
        void editor.play(shown.from).then(() => {
          if (!untrack(options.playing)) unmark();
        });
        return;
      case "export":
        // Opening the dialog is not the step: exporting is still theirs.
        unmark();
        editor.openExport();
        return;
      case "sound":
        void editor.putSound(shown.role, shown.trackId, shown.padId).then((put) => {
          if (put) return;
          unmark();
          setNotice(NO_SOUND);
        });
    }
  }

  return { notice, clearNotice: () => setNotice(null), showMe, arrive };
}
