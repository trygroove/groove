import { For, type JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import {
  GLOSSARY,
  instructionParts,
  type TermId,
  termView,
} from "../../lessons/glossary";
import {
  biteOf,
  chapterOf,
  followingBite,
  followingChapter,
  type LessonState,
  lessonOf,
} from "../../lessons/session";
import {
  chapterStanding,
  LESSON_INTRO,
  planEyebrow,
  planPlace,
  planTick,
  STATUS_WORDS,
  showsIntro,
  type Tick,
} from "./lessonPlanModel";
import type { Lesson } from "./useLesson";

/** The plan's accessible name (GRV-43, GRV-190). */
export const LESSON_LABEL = "Lesson";

/** The ticks of one chapter, one per bite: drawn, never read out. */
function Ticks(props: { readonly ticks: readonly Tick[] }): JSX.Element {
  return (
    <span class="lesson-ticks" aria-hidden="true">
      <For each={props.ticks}>{(tick) => <i data-tick={tick} />}</For>
    </span>
  );
}

/** What a chapter's column says to a screen reader. */
function chapterWords(title: string, ticks: readonly Tick[]): string {
  const done = ticks.filter((tick) => tick === "done").length;
  return `${title}: ${done} of ${ticks.length} done`;
}

/**
 * The lesson under way, as a header under the panel's (GRV-190, after
 * docs/assistant-panel.html, step 11): the eyebrow with the place, a fold
 * toggle and Leave; the chapter strip, a column per chapter and a tick per
 * bite; the chapter's bites as chips; the step with its terms to tap; and
 * Show me and Skip, or Next once the bite is over. Folded, it keeps its first
 * two rows, the eyebrow naming the bite, so the producer can talk under it;
 * the next transition unfolds it.
 *
 * Coproducer's words are in the conversation under it; this is only what the
 * producer acts on. Focus that was in the plan stays in it as the step moves
 * on, rather than dropping to the studio.
 */
export default function LessonPlan(props: {
  readonly lesson: Lesson;
  readonly state: LessonState;
  /** Where focus goes when the plan leaves with it, the lesson over. */
  readonly onFocusLost?: () => void;
}): JSX.Element {
  let root: HTMLElement | undefined;
  const [folded, setFolded] = createSignal(false);
  const [term, setTerm] = createSignal<TermId | null>(null);
  const lesson = () => lessonOf(props.state);
  const chapter = () => chapterOf(props.state);
  const bite = () => biteOf(props.state);
  const many = () => lesson().chapters.length > 1;
  const following = () => followingBite(props.state);
  // The chapter Next starts once this one is over: the one it will really
  // start, past a chapter the song already has all of.
  const nextChapter = () => {
    if (props.state.step !== null || following() || !followingChapter(props.state)) {
      return null;
    }
    const next = props.lesson.upcoming();
    return next ? chapterOf(next) : null;
  };
  const instruction = () => props.state.step?.instruction ?? "";
  const parts = createMemo(() => instructionParts(instruction()));
  const where = () =>
    [
      props.state.lessonId,
      props.state.chapterIndex,
      props.state.biteIndex,
      props.state.step?.index ?? "over",
    ].join("|");

  // A transition unfolds the plan, puts away the last step's definition, and
  // keeps focus that was in the plan in it: on the action now there, or the
  // plan itself. The place is the one reactive read; the rest writes.
  let hadFocus = false;
  // The control that lost focus to nowhere, while it may yet turn out to have
  // left the page with it. Chrome blurs a focused button as it is removed,
  // while it is still connected (GRV-190 QA: Enter on Show me), so its
  // `focusout` alone cannot say whether the producer moved on or the step did.
  let leaving: Element | null = null;
  const keptFocus = () => hadFocus || (leaving !== null && !leaving.isConnected);
  createEffect(where, () => {
    setFolded(false);
    setTerm(null);
    if (!hadFocus && leaving === null) return;
    queueMicrotask(() => {
      if (!keptFocus()) return;
      leaving = null;
      const active = document.activeElement;
      if (
        !root?.isConnected ||
        (active && active !== document.body && root.contains(active))
      )
        return;
      const action = root.querySelector<HTMLElement>(".lesson-plan-actions button");
      (action ?? root).focus({ preventScroll: true });
    });
  });
  onCleanup(() => {
    if (!hadFocus && leaving === null) return;
    queueMicrotask(() => {
      if (!keptFocus()) return;
      const active = document.activeElement;
      if (!active || active === document.body) props.onFocusLost?.();
    });
  });

  const definitionId = "lesson-definition";
  const pressTerm = (id: TermId) => {
    setTerm((current) => (current === id ? null : id));
    const view = termView(id);
    if (view) props.lesson.openView(view);
  };

  return (
    <section
      ref={root}
      class="lesson-plan"
      aria-label={LESSON_LABEL}
      data-folded={folded() ? "true" : "false"}
      tabindex={-1}
      onFocusIn={() => {
        hadFocus = true;
        leaving = null;
      }}
      onFocusOut={(event) => {
        hadFocus = root?.contains(event.relatedTarget as Node | null) ?? false;
        const target = event.target instanceof Element ? event.target : null;
        // A button that leaves the page with focus took it with it.
        if (target && !target.isConnected) hadFocus = true;
        leaving = !hadFocus && event.relatedTarget === null ? target : null;
        // It leaves within this task or not at all: a control still on the
        // page after it lost focus to nowhere (a click on the canvas) does not
        // pull focus back later.
        if (leaving) {
          const left = leaving;
          setTimeout(() => {
            if (leaving === left && left.isConnected) leaving = null;
          }, 0);
        }
      }}
    >
      <div class="lesson-plan-head">
        <button
          type="button"
          class="lesson-plan-fold"
          aria-expanded={folded() ? "false" : "true"}
          aria-label={folded() ? "Show the step" : "Fold the plan"}
          title={folded() ? "Show the step" : "Fold the plan"}
          onClick={() => setFolded((now) => !now)}
        />
        <h3 class="lesson-plan-eyebrow">{planEyebrow(props.state)}</h3>
        <span class="lesson-plan-place">
          {folded() ? bite().title : planPlace(props.state)}
        </span>
        <button
          type="button"
          class="lesson-plan-leave"
          onClick={() => props.lesson.leave()}
        >
          Leave
        </button>
      </div>
      <ol class="lesson-chapters" aria-label="Chapters">
        <For each={lesson().chapters}>
          {(each, index) => {
            const ticks = () => each.bites.map((one) => planTick(props.state, one));
            return (
              <li data-state={chapterStanding(props.state, index())} title={each.title}>
                <Show when={many()}>
                  <span class="lesson-chapter-name" aria-hidden="true">
                    {each.short}
                  </span>
                </Show>
                <Ticks ticks={ticks()} />
                <span class="visually-hidden">{chapterWords(each.title, ticks())}</span>
              </li>
            );
          }}
        </For>
      </ol>
      <Show when={!folded()}>
        <Show when={showsIntro(props.state)}>
          <p class="lesson-plan-intro">{LESSON_INTRO}</p>
        </Show>
        <ol class="lesson-bites" aria-label="Bites">
          <For each={chapter().bites}>
            {(each) => {
              const tick = () => planTick(props.state, each);
              const words = () => {
                const now = tick();
                return now === "done" || now === "skipped" || now === "passed"
                  ? STATUS_WORDS[now]
                  : null;
              };
              return (
                <li
                  class="lesson-bite"
                  data-tick={tick()}
                  aria-current={each.id === bite().id ? "step" : undefined}
                >
                  <span class="lesson-bite-title">{each.title}</span>
                  <Show when={words()}>
                    {(said) => <span class="lesson-bite-status">· {said()}</span>}
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
        <Switch>
          <Match when={props.state.step}>
            <p class="lesson-step">
              <For each={parts()}>
                {(value) => {
                  const part = value;
                  return part.kind === "text" ? (
                    part.text
                  ) : (
                    <button
                      type="button"
                      class="lesson-term"
                      aria-expanded={term() === part.term ? "true" : "false"}
                      aria-controls={definitionId}
                      onClick={() => pressTerm(part.term)}
                    >
                      {part.text}
                    </button>
                  );
                }}
              </For>
            </p>
            <Show when={term()}>
              {(shown) => (
                <p class="lesson-definition" id={definitionId}>
                  <b>{GLOSSARY[shown()].term}</b> {GLOSSARY[shown()].definition}
                </p>
              )}
            </Show>
            <div class="lesson-plan-actions">
              <Show when={props.lesson.canShowMe}>
                <button
                  type="button"
                  class="assistant-button-primary"
                  disabled={props.lesson.busy()}
                  onClick={() => props.lesson.showMe()}
                >
                  Show me
                </button>
              </Show>
              <button
                type="button"
                class="memory-proposal-secondary"
                onClick={() => props.lesson.skip()}
              >
                Skip
              </button>
            </div>
          </Match>
          <Match when={following()}>
            {(next) => (
              <div class="lesson-plan-actions">
                <button
                  type="button"
                  class="assistant-button-primary"
                  onClick={() => props.lesson.next()}
                >
                  Next: {next().title}
                </button>
              </div>
            )}
          </Match>
          <Match when={nextChapter()}>
            {(next) => (
              <div class="lesson-plan-actions">
                <button
                  type="button"
                  class="assistant-button-primary"
                  onClick={() => props.lesson.next()}
                >
                  Next chapter: {next().title}
                </button>
              </div>
            )}
          </Match>
        </Switch>
        <Show when={props.lesson.notice()}>
          {(notice) => <output class="lesson-notice">{notice()}</output>}
        </Show>
      </Show>
    </section>
  );
}
