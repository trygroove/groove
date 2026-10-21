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
 * A turn that cannot go yet (a reply is still on its way) waits; turns that
 * wait together go as one (`foldTurns`), the newest carrying the others, so
 * a bite finished while Coproducer was still writing is still celebrated.
 *
 * - **Where to act**: the step's control wears the dashed proposal mark
 *   (`UI-004`) while it is under way, and what it belongs to is selected.
 * - **Show me** goes through the editor as the assistant: commands as one
 *   undoable change, a view switch, Play, or a library sound on a pad.
 * - **Done state** is saved on the producer's profile as each bite is done,
 *   by the producer or by Show me (`lessonsDone`). A skipped bite is not
 *   done: it is still the next unfinished one.
 * - **Where it stands** is kept beside the conversation (`lessonStore.ts`),
 *   so a reload brings the card back at the bite it was on.
 *
 * Analytics: `lesson_bite_started` (where from), `lesson_bite_completed`
 * (how), `lesson_chapter_completed` and `lesson_track_completed` (GRV-44),
 * `lesson_dropped_out` and `feature_first_use` `lessons`, by chapter and bite
 * ID only.
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
import { cueMessage, foldTurns, type LessonTurn, lessonCue } from "../../lessons/cue";
import {
  type BiteId,
  type ChapterId,
  isTrackChapterId,
  type LessonChoice,
  type LessonSource,
  TRACK_UNDER_WAY,
  type TrackChapterId,
} from "../../lessons/ids";
import {
  biteOf,
  chapterOf,
  type LessonEvent,
  type LessonState,
  type LessonTransition,
  markShown,
  observe,
  resumeLesson,
  skip as skipStep,
  startBite,
  startNextBite,
  startTrack,
} from "../../lessons/session";
import { beatStyleFor } from "../../lessons/style";
import { trackProgress, trackResume, withTrackUnderWay } from "../../lessons/track";
import type { LessonSettings, LessonWorld, ShowMe } from "../../lessons/types";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import type { EditorViewName } from "../composition/editorViews";
import { type LessonStore, storedLesson } from "./lessonStore";
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

export interface UseLessonOptions {
  /** The committed project, never a preview of it. */
  readonly project: Accessor<Project | null>;
  readonly view: Accessor<EditorViewName>;
  readonly playing: Accessor<boolean>;
  /**
   * What "Finish a track" listens for (GRV-44): the bar the playhead is in,
   * the bars heard and the master's clips since the song last started
   * playing, and the stem exports started. Each reads 0 without one.
   */
  readonly listening?: LessonListening;
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
  /**
   * Where the lesson under way is kept across a reload, under `key`, or
   * null while there is nowhere to keep it. Without it, it is not kept.
   */
  readonly saved?: { readonly key: Accessor<string | null>; readonly store: LessonStore };
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
  /**
   * Starts `lesson` at `biteId`, or at its first bite not yet done; whether
   * it could (not while no project is open). "track", or one of "Finish a
   * track"'s own chapters, starts that lesson (GRV-44): where it was left,
   * passing over what the song already has.
   */
  start(lesson: LessonChoice | ChapterId, source: LessonSource, biteId?: BiteId): boolean;
  /** The next bite, once the one before is over. */
  next(): void;
  /**
   * Where {@link next} would go now, read against the world as it stands:
   * the chapter and bite it would start, past what the song already has.
   * Null when it would start nothing.
   */
  upcoming(): LessonState | null;
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

/**
 * Whether `lesson` starts "Finish a track" (GRV-44): "track" itself, or one of
 * its own chapters. "Make a beat" is a chapter of its own as well as the
 * track's first: alone it is the chapter, unless the lesson, by what `done`
 * records, is under way and still on it, when it is the lesson's chapter 1.
 */
function isTrackLesson(
  lesson: LessonChoice | ChapterId,
  done: readonly string[],
): boolean {
  if (lesson === "beat") return trackResume(done)?.chapter === "beat";
  return lesson === "track" || isTrackChapterId(lesson);
}

/** What the editor reports to "Finish a track" (GRV-44), each an accessor. */
export interface LessonListening {
  readonly bar: Accessor<number>;
  readonly barsHeard: Accessor<number>;
  readonly masterClips: Accessor<number>;
  readonly stemExports: Accessor<number>;
}

interface PendingTurn extends LessonTurn {
  readonly chapter: string;
}

/**
 * How long Show me waits for the view it asked for before deciding it did
 * not open, and taking its mark back.
 */
export const SHOW_ME_SETTLE_MS = 1000;

export function useLesson(options: UseLessonOptions): Lesson {
  const [state, setState] = createSignal<LessonState | null>(null);
  // The turns waiting for a reply to finish, oldest first.
  const [pending, setPending] = createSignal<readonly PendingTurn[]>([]);
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
    return project
      ? {
          project,
          view: options.view(),
          playing: options.playing(),
          bar: options.listening?.bar() ?? 0,
          barsHeard: options.listening?.barsHeard() ?? 0,
          masterClips: options.listening?.masterClips() ?? 0,
          stemExports: options.listening?.stemExports() ?? 0,
        }
      : null;
  }

  function queue(next: LessonState, event: LessonEvent): void {
    const turn: PendingTurn = {
      text: cueMessage(next, event),
      cue: lessonCue(next, event, untrack(settings), untrack(done)),
      chapter: chapterOf(next).title,
    };
    setPending((waiting) => [...waiting, turn]);
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
      const analytics = options.analytics();
      analytics.log("lesson_bite_completed", { ...ids(next), how: event.how });
      if (event.how !== "skipped") record(biteOf(next).id);
      if (event.chapterDone) {
        analytics.log("lesson_chapter_completed", { chapter_id: next.chapter });
      }
      // The track is finished by exporting its stems, not by skipping that.
      if (event.trackDone && event.how !== "skipped") {
        analytics.log("lesson_track_completed", {});
      }
    }
    queue(next, event);
    // A chapter's last bite ends the lesson, unless "Finish a track" goes on
    // to its next chapter: the wrap-up follows in the conversation, and the
    // panel has no lesson to show.
    const over =
      event.kind === "bite_done" &&
      (event.trackDone || (event.chapterDone && !next.track));
    setState(over ? null : next);
    arrive(next, event.kind === "step_done");
  }

  /** Saves "Finish a track" as under way, once, so it resumes from any bite. */
  function recordTrackUnderWay(): void {
    if (untrack(done).includes(TRACK_UNDER_WAY)) return;
    setFinished((current) => withTrackUnderWay(current));
    void options.profile?.update((profile) => ({
      ...profile,
      lessonsDone: withTrackUnderWay(profile.lessonsDone),
    }));
  }

  function begin(transition: LessonTransition, source: LessonSource): void {
    setNotice(null);
    setState(transition.state);
    if (transition.state.track) recordTrackUnderWay();
    const analytics = options.analytics();
    // What the song already had is done as far as the lesson goes (GRV-44):
    // saved, so picking the lesson up again starts past it, but never logged
    // as a bite the producer went through.
    if (transition.event.kind === "bite_started") {
      for (const id of transition.event.passed) record(id);
    }
    analytics.log("lesson_bite_started", { ...ids(transition.state), source });
    analytics.logFeatureFirstUse("lessons");
    queue(transition.state, transition.event);
    arrive(transition.state, true);
  }

  /**
   * A step just started: one whose Show me only opens where to act (the
   * Export dialog, GRV-44) opens it now. It is not the step done, so nothing
   * is marked shown.
   */
  function arrive(next: LessonState, started: boolean): void {
    if (!started || !next.step) return;
    const step = biteOf(next).steps[next.step.index];
    if (!step.showsAtStart) return;
    const now = world();
    const shown = now && step.showMe(now, untrack(settings), factory());
    if (shown) act(shown);
  }

  /** Has the editor do what Show me says; whether it can tell yet that it did not. */
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

  // The lesson kept from before a reload comes back once there is a project
  // to read it against, silently: the conversation already has its turns.
  // Each key is read once, and only then is the lesson kept under it, so the
  // empty lesson of a page still loading never wipes the one kept.
  let restoredKey: string | null = null;
  createEffect(
    () => ({ key: options.saved?.key() ?? null, ready: world() !== null }),
    ({ key, ready }) => {
      const saved = options.saved;
      if (!saved || !key || !ready || restoredKey === key) return;
      restoredKey = key;
      const kept = saved.store.load(key);
      const now = untrack(world);
      if (!kept || !now || untrack(state)) return;
      setState(
        resumeLesson(kept.chapter, kept.bite, now, untrack(settings), kept.endings, {
          track: kept.track,
          passed: kept.passed,
          behind: kept.behind,
        }),
      );
    },
  );
  createEffect(
    () => ({ current: state(), key: options.saved?.key() ?? null }),
    ({ current, key }) => {
      if (!key || restoredKey !== key) return;
      options.saved?.store.save(key, current ? storedLesson(current) : null);
    },
  );

  // A lesson's turn goes as soon as no reply is on its way; the turns that
  // waited for one go together, as the newest carrying the rest.
  createEffect(
    () => ({ waiting: pending(), busy: options.conversation.streaming() }),
    ({ waiting, busy }) => {
      const [first, ...rest] = waiting;
      if (!first || busy) return;
      const turn = foldTurns([first, ...rest]);
      const chapter = waiting[waiting.length - 1]?.chapter ?? first.chapter;
      // Sending reads the conversation as it stands; it is not what this waits on.
      const sent = untrack(() =>
        options.conversation.sendLesson(turn.text, turn.cue, chapter),
      );
      // Only what went is taken off: a turn queued meanwhile waits on.
      if (sent) setPending((now) => now.slice(waiting.length));
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

  /**
   * Where "Finish a track" starts (GRV-44): where it was left, or chapter
   * `from`. Either way, while it is under way it goes on past what the
   * producer has already done (`trackProgress`), never back over it.
   */
  function trackStart(
    now: LessonWorld,
    from: TrackChapterId | null,
    biteId: BiteId | undefined,
  ): LessonTransition | null {
    const progress = trackProgress(done());
    if (from === null) {
      const resume = trackResume(done());
      return startTrack(
        resume?.chapter ?? "beat",
        resume?.biteId ?? null,
        now,
        settings(),
        [],
        progress,
      );
    }
    const finishedIds = new Set(done());
    const first =
      biteId ??
      chapterOfId(from).bites.find((one) => !finishedIds.has(one.id))?.id ??
      null;
    return startTrack(from, first, now, settings(), [], progress);
  }

  function start(
    lesson: LessonChoice | ChapterId,
    source: LessonSource,
    biteId?: BiteId,
  ): boolean {
    const now = world();
    if (!now) return false;
    const transition = isTrackLesson(lesson, done())
      ? trackStart(now, lesson === "track" ? null : (lesson as TrackChapterId), biteId)
      : soloStart(now, lesson as ChapterId, biteId);
    if (!transition) return false;
    const current = state();
    if (current) {
      options.analytics().log("lesson_dropped_out", ids(current));
    }
    begin(transition, source);
    return true;
  }

  /** A chapter taught alone, at `biteId` or its first bite not yet done. */
  function soloStart(now: LessonWorld, chapterId: ChapterId, biteId?: BiteId) {
    const finishedIds = new Set(done());
    const first =
      biteId ??
      chapterOfId(chapterId).bites.find((one) => !finishedIds.has(one.id))?.id ??
      null;
    return startBite(chapterId, first, now, settings());
  }

  function next(): void {
    const current = state();
    const now = world();
    if (!current || !now) return;
    const transition = startNextBite(current, now, settings(), trackProgress(done()));
    if (transition) begin(transition, "next");
  }

  function upcoming(): LessonState | null {
    const current = state();
    const now = world();
    if (!current || !now) return null;
    return startNextBite(current, now, settings(), trackProgress(done()))?.state ?? null;
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
        // A view that never opens is no Show me: the producer who then goes
        // there by hand did it themselves.
        setTimeout(() => {
          if (untrack(() => options.view()) !== shown.view) unmark();
        }, SHOW_ME_SETTLE_MS);
        return;
      case "play":
        void editor.play(shown.from).then(() => {
          if (!untrack(() => options.playing())) unmark();
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
    setPending([]);
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
    upcoming,
    showMe,
    skip,
    leave,
    context() {
      const current = state();
      return current ? lessonCue(current, null, settings(), done()) : null;
    },
  };
}
