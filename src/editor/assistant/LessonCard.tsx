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
import { GLOSSARY, instructionParts, type TermId } from "../../lessons/glossary";
import type { BiteEnding, BiteId } from "../../lessons/ids";
import { biteOf, chapterOf, type LessonState } from "../../lessons/session";
import type { Lesson } from "./useLesson";

/** The lesson card's accessible name (GRV-43). */
export const LESSON_LABEL = "Lesson";

/** What a bite's line says once it is over. */
export function endingWord(ending: BiteEnding | "earlier"): string {
  return ending === "skipped" ? "skipped" : "done";
}

/**
 * The lesson under way, in the assistant's panel (GRV-43): the chapter, its
 * bites with what is done, the step with its terms to tap, Show me and Skip,
 * and once a bite is over, the next one to pull. "Leave" drops out.
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
  const following = () => chapter().bites[props.state.biteIndex + 1] ?? null;
  const [term, setTerm] = createSignal<TermId | null>(null);
  const instruction = () => props.state.step?.instruction ?? "";
  const parts = createMemo(() => instructionParts(instruction()));
  // A new step puts away the last one's definition. The instruction is the
  // one reactive read; closing the definition writes, so it is the apply
  // half's.
  createEffect(instruction, () => {
    setTerm(null);
  });
  const status = (id: BiteId): BiteEnding | "earlier" | null => {
    const ending = props.state.endings[id];
    if (ending) return ending;
    return props.lesson.done().includes(id) ? "earlier" : null;
  };
  const definitionId = "lesson-definition";

  return (
    <section class="assistant-card lesson-card" aria-label={LESSON_LABEL}>
      <div class="lesson-card-head">
        <div class="lesson-card-title">
          <span class="assistant-entry-label">
            Lesson · bite {props.state.biteIndex + 1} of {chapter().bites.length}
          </span>
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
      </Switch>
      <Show when={props.lesson.notice()}>
        {(notice) => <output class="lesson-notice">{notice()}</output>}
      </Show>
    </section>
  );
}
