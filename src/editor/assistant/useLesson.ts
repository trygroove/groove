/**
 * The lesson under way in the assistant's panel (GRV-43): which chapter and
 * bite, the step and where to act, and what Show me, Skip, Next and Leave do.
 *
 * The lesson itself is pure (`src/lessons/session.ts`); this holds it and
 * feeds it the world as it changes: the committed project, the view on
 * screen and whether the song plays. When a step's predicate holds, the step
 * is done, by the producer or by Show me; each transition is one turn to
 * Coproducer (`sendLesson`), which writes the words: introducing a bite,
 * commenting on what was done, celebrating it, and wrapping the chapter up.
 * A turn that cannot go yet (a reply is still on its way) waits, and a newer
 * one takes its place.
 *
 * - **Where to act**: the step's control wears the dashed proposal mark
 *   (`UI-004`) while it is under way, and what it belongs to is selected.
 * - **Show me** goes through the editor as the assistant: commands as one
 *   undoable change, a view switch, Play, or a library sound on a pad.
 * - **Done state** is saved on the producer's profile as each bite ends,
 *   however it ended (`lessonsDone`).
 *
 * Analytics: `lesson_bite_started` (where from), `lesson_bite_completed`
 * (how), `lesson_dropped_out` and `feature_first_use` `lessons`, by chapter
 * and bite ID only.
 */
import { type Accessor, createEffect, createMemo, createSignal, untrack } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { AssistantLessonContext } from "../../assistant/lesson";
import type { ControlAddress } from "../../commands/controlAddress";
import type { RawCommandInput } from "../../commands/types";
import type { ControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import { createFactoryContext, type DomainFactoryContext } from "../../domain/factories";
import type { PadId, TrackId } from "../../domain/ids";
import { chapter as chapterOfId, withBiteDone } from "../../lessons/chapters";
import { cueMessage, lessonCue } from "../../lessons/cue";
import type { BiteId, ChapterId, LessonSource } from "../../lessons/ids";
import {
  biteOf,
  chapterOf,
  type LessonEvent,
  type LessonState,
  type LessonTransition,
  markShown,
  observe,
  skip as skipStep,
  startBite,
  startNextBite,
} from "../../lessons/session";
import { beatStyleFor } from "../../lessons/style";
import type { LessonSettings, LessonWorld } from "../../lessons/types";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import type { EditorViewName } from "../editorViews";
import type { AssistantConversation } from "./useAssistantConversation";

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
  play(): void;
  /** Puts a library sound of `role` on the pad, as the Library's Insert; whether it did. */
  putSound(role: "kick", trackId: TrackId, padId: PadId): Promise<boolean>;
}

export interface UseLessonOptions {
  /** The committed project, never a preview of it. */
  readonly project: Accessor<Project | null>;
  readonly view: Accessor<EditorViewName>;
  readonly playing: Accessor<boolean>;
  /** Where the bites done are saved, and what the beat style is read from. */
  readonly profile?: ProducerProfileStore;
  readonly conversation: Pick<AssistantConversation, "sendLesson" | "streaming">;
  /** Without one, Show me has nothing to do. */
  readonly editor?: LessonEditorPort;
  /** Where the step's control is marked. */
  readonly registry?: Pick<ControlRegistry, "setMark">;
  readonly analytics: () => Pick<Analytics, "log" | "logFeatureFirstUse">;
  /** Makes Show me's new IDs; fresh ones by default. */
  readonly factoryContext?: () => DomainFactoryContext;
}

export interface Lesson {
  /** The lesson under way, or null outside one. */
  readonly state: Accessor<LessonState | null>;
  /** Every bite the producer has been through, saved or just finished. */
  readonly done: Accessor<readonly string[]>;
  /** A word after Show me could not do anything. */
  readonly notice: Accessor<string | null>;
  /** Whether Show me has an editor to work in. */
  readonly canShowMe: boolean;
  /** Starts `chapter` at `biteId`, or at its first bite not yet done. */
  start(chapter: ChapterId, source: LessonSource, biteId?: BiteId): void;
  /** The next bite, once the one before is over. */
  next(): void;
  showMe(): void;
  skip(): void;
  /** Leaves the lesson part-way. */
  leave(): void;
  /** The lesson as a turn the producer writes mid-lesson carries it. */
  context(): AssistantLessonContext | null;
}

/** What Show me says when it has nothing to do. */
export const NOTHING_TO_SHOW = "There's nothing to show here: this step is already done.";
/** What Show me says when the change would not go in. */
export const SHOW_ME_FAILED = "That didn't go in. Try it by hand, or press Skip.";
/** What Show me says when the library has no other kick to offer. */
export const NO_SOUND =
  "I couldn't find another kick in the library. Pick one by hand, or press Skip.";

interface PendingTurn {
  readonly text: string;
  readonly cue: AssistantLessonContext;
  readonly chapter: string;
}

export function useLesson(options: UseLessonOptions): Lesson {
  const [state, setState] = createSignal<LessonState | null>(null);
  const [pending, setPending] = createSignal<PendingTurn | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [finished, setFinished] = createSignal<readonly string[]>([]);
  const factory = options.factoryContext ?? (() => createFactoryContext());

  const settings = createMemo(
    (): LessonSettings => ({
      style: beatStyleFor(options.profile?.profile()?.memory.taste ?? []),
    }),
  );
  const done = createMemo((): readonly string[] => {
    let all = [...(options.profile?.profile()?.lessonsDone ?? [])];
    for (const id of finished()) all = withBiteDone(all, id as BiteId);
    return all;
  });

  function world(): LessonWorld | null {
    const project = options.project();
    return project ? { project, view: options.view(), playing: options.playing() } : null;
  }

  function queue(next: LessonState, event: LessonEvent): void {
    setPending({
      text: cueMessage(next, event),
      cue: lessonCue(next, event, untrack(settings), untrack(done)),
      chapter: chapterOf(next).title,
    });
  }

  function ids(next: LessonState) {
    return { chapter_id: next.chapter, bite_id: biteOf(next).id };
  }

  function record(biteId: BiteId): void {
    setFinished((current) => withBiteDone(current, biteId));
    void options.profile?.update((profile) => ({
      ...profile,
      lessonsDone: withBiteDone(profile.lessonsDone, biteId),
    }));
  }

  function handle(transition: LessonTransition): void {
    const { state: next, event } = transition;
    setNotice(null);
    if (event.kind === "bite_done") {
      options.analytics().log("lesson_bite_completed", { ...ids(next), how: event.how });
      record(biteOf(next).id);
    }
    queue(next, event);
    // A chapter's last bite ends the lesson: the wrap-up follows in the
    // conversation, and the panel has no lesson to show.
    setState(event.kind === "bite_done" && event.chapterDone ? null : next);
  }

  function begin(transition: LessonTransition, source: LessonSource): void {
    setNotice(null);
    setState(transition.state);
    const analytics = options.analytics();
    analytics.log("lesson_bite_started", { ...ids(transition.state), source });
    analytics.logFeatureFirstUse("lessons");
    queue(transition.state, transition.event);
  }

  // The step under way is read against the world as it changes: once its
  // predicate holds, it is done. The state and the world are the reactive
  // reads; ending the step writes, so it is the apply half's.
  createEffect(
    () => ({ current: state(), now: world() }),
    ({ current, now }) => {
      if (!current || !now) return;
      const transition = observe(current, now, untrack(settings));
      if (transition) handle(transition);
    },
  );

  // A lesson's turn goes as soon as no reply is on its way.
  createEffect(
    () => ({ turn: pending(), busy: options.conversation.streaming() }),
    ({ turn, busy }) => {
      if (!turn || busy) return;
      // Sending reads the conversation as it stands; it is not what this waits on.
      const sent = untrack(() =>
        options.conversation.sendLesson(turn.text, turn.cue, turn.chapter),
      );
      if (sent) setPending(null);
    },
  );

  // Where to act wears the dashed mark while its step is under way, and is
  // selected, so the view the step names opens on it. The target is read off
  // the world the step started in, so it holds still.
  createEffect(
    (): ControlAddress | null => {
      const current = state();
      if (!current?.step) return null;
      const step = biteOf(current).steps[current.step.index];
      return step.target(current.step.start, settings());
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

  function start(chapterId: ChapterId, source: LessonSource, biteId?: BiteId): void {
    const now = world();
    if (!now) return;
    const current = state();
    if (current) {
      options.analytics().log("lesson_dropped_out", ids(current));
    }
    const finishedIds = new Set(done());
    const first =
      biteId ??
      chapterOfId(chapterId).bites.find((one) => !finishedIds.has(one.id))?.id ??
      null;
    begin(startBite(chapterId, first, now, settings()), source);
  }

  function next(): void {
    const current = state();
    const now = world();
    if (!current || !now) return;
    const transition = startNextBite(current, now, settings());
    if (transition) begin(transition, "next");
  }

  function showMe(): void {
    const current = state();
    const now = world();
    const editor = options.editor;
    if (!current?.step || !now || !editor) return;
    const step = biteOf(current).steps[current.step.index];
    const shown = step.showMe(now, settings(), factory());
    if (!shown) {
      setNotice(NOTHING_TO_SHOW);
      return;
    }
    setNotice(null);
    // Marked before the editor acts, so the change it makes is read as Show
    // me's when the step sees it; taken back if the editor could not act, so
    // a producer who then does the step by hand is credited with it.
    const marked = markShown(current);
    setState(marked);
    // The updater form, which sees the write above even before it flushes.
    const unmark = () => setState((now) => (now === marked ? current : now));
    switch (shown.kind) {
      case "commands":
        if (!editor.apply(shown.commands)) {
          unmark();
          setNotice(SHOW_ME_FAILED);
        }
        return;
      case "view":
        editor.goTo(shown.view);
        return;
      case "play":
        editor.play();
        return;
      case "sound":
        void editor.putSound(shown.role, shown.trackId, shown.padId).then((put) => {
          if (put) return;
          unmark();
          setNotice(NO_SOUND);
        });
    }
  }

  function skip(): void {
    const current = state();
    const now = world();
    if (!current || !now) return;
    const transition = skipStep(current, now, settings());
    if (transition) handle(transition);
  }

  function leave(): void {
    const current = state();
    if (!current) return;
    options.analytics().log("lesson_dropped_out", ids(current));
    setPending(null);
    setNotice(null);
    setState(null);
  }

  return {
    state,
    done,
    notice,
    canShowMe: options.editor !== undefined,
    start,
    next,
    showMe,
    skip,
    leave,
    context() {
      const current = state();
      return current ? lessonCue(current, null, settings(), done()) : null;
    },
  };
}
