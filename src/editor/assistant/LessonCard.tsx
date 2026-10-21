import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { chapter as chapterById } from "../../lessons/chapters";
import { GLOSSARY, instructionParts, type TermId } from "../../lessons/glossary";
import { type BiteEnding, type BiteId, TRACK_CHAPTER_IDS } from "../../lessons/ids";
import {
  biteOf,
  chapterFinished,
  chapterOf,
  followingBite,
  followingChapter,
  type LessonState,
} from "../../lessons/session";
import { TRACK_TITLE, trackChapterNumber } from "../../lessons/track";
import type { Lesson } from "./useLesson";

/** The lesson card's accessible name (GRV-43). */
export const LESSON_LABEL = "Lesson";

/** How a bite in the list stands: how it ended, or done before, or passed over. */
export type BiteStatus = BiteEnding | "earlier" | "passed";

/** What a bite's line says once it is over. */
export function endingWord(ending: BiteStatus): string {
  if (ending === "passed") return "already in your song";
  return ending === "skipped" ? "skipped" : "done";
}

/** The card's eyebrow: where the lesson stands. */
export function lessonPlace(state: LessonState): string {
  // A bite over waits for Next, so the place says it is done, not still to do.
  const over = state.step === null ? " · done" : "";
  const bites = `bite ${state.biteIndex + 1} of ${chapterOf(state).bites.length}${over}`;
  if (!state.track) return `Lesson · ${bites}`;
  const chapter = state.chapter as (typeof TRACK_CHAPTER_IDS)[number];
  return `${TRACK_TITLE} · chapter ${trackChapterNumber(chapter)} of ${TRACK_CHAPTER_IDS.length} · ${bites}`;
}

/**
 * The lesson under way, in the assistant's panel (GRV-43): the chapter, its
 * bites with what is done, the step with its terms to tap, Show me and Skip,
 * and once a bite is over, the next one to pull. "Leave" drops out. In
 * "Finish a track" (GRV-44) it says which of the five chapters this is, marks
 * the bites the song already had, and once a chapter is over offers the next.
 *
 * Coproducer's words are in the conversation above it; this is only what
 * the producer acts on. Nothing here celebrates: that is Coproducer's, in
 * words.
 */
export default function LessonCard(props: {
  readonly lesson: Lesson;
  readonly state: LessonState;
}): JSX.Element {
  const chapter = () => chapterOf(props.state);
  const bite = () => biteOf(props.state);
  const following = () => followingBite(props.state);
  // "Finish a track" goes on to its next chapter once this one is over
  // (GRV-44): the one Next will start, which passes over a chapter the song
  // already has all of.
  const nextChapter = () => {
    if (!chapterFinished(props.state) || !followingChapter(props.state)) return null;
    const next = props.lesson.upcoming();
    return next ? chapterById(next.chapter) : null;
  };
  const [term, setTerm] = createSignal<TermId | null>(null);
  const instruction = () => props.state.step?.instruction ?? "";
  const parts = createMemo(() => instructionParts(instruction()));
  // A new step puts away the last one's definition. The instruction is the
  // one reactive read; closing the definition writes, so it is the apply
  // half's.
  createEffect(instruction, () => {
    setTerm(null);
  });
  const status = (id: BiteId): BiteStatus | null => {
    const ending = props.state.endings[id];
    if (ending) return ending;
    if (props.state.passed.includes(id)) return "passed";
    // "Finish a track" passes over only what it says it does (GRV-44): a bite
    // done in another lesson or song, and taught again here, is not done yet.
    if (props.state.track) return props.state.behind.includes(id) ? "earlier" : null;
    return props.lesson.done().includes(id) ? "earlier" : null;
  };
  const definitionId = "lesson-definition";

  return (
    <section class="assistant-card lesson-card" aria-label={LESSON_LABEL}>
      <div class="lesson-card-head">
        <div class="lesson-card-title">
          <span class="assistant-entry-label">{lessonPlace(props.state)}</span>
          <h3>{chapter().title}</h3>
        </div>
        <button
          type="button"
          class="memory-proposal-secondary lesson-leave"
          onClick={() => props.lesson.leave()}
        >
          Leave
        </button>
      </div>
      <ol class="lesson-bites" aria-label="Bites">
        <For each={chapter().bites}>
          {(each) => (
            <li
              class={["lesson-bite", { "lesson-bite-over": status(each.id) !== null }]}
              aria-current={each.id === bite().id ? "step" : undefined}
            >
              <span class="lesson-bite-title">{each.title}</span>
              <Show when={status(each.id)}>
                {(ending) => (
                  <span class="lesson-bite-status">· {endingWord(ending())}</span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Switch>
        <Match when={props.state.step}>
          <p class="lesson-step">
            <For each={parts()}>
              {(value) => {
                return value.kind === "text" ? (
                  value.text
                ) : (
                  <button
                    type="button"
                    class="lesson-term"
                    aria-expanded={term() === value.term ? "true" : "false"}
                    aria-controls={definitionId}
                    onClick={() => {
                      setTerm((current) => (current === value.term ? null : value.term));
                    }}
                  >
                    {value.text}
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
          <div class="memory-proposal-actions">
            <Show when={props.lesson.canShowMe}>
              <button
                type="button"
                class="assistant-button-primary"
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
            <div class="memory-proposal-actions">
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
            <div class="memory-proposal-actions">
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
    </section>
  );
}
