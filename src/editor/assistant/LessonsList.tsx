import { For, type JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { LESSONS } from "../../lessons/chapters";
import type { LessonId } from "../../lessons/ids";
import { lessonProgress, type Tick } from "./lessonPlanModel";
import type { Lesson } from "./useLesson";

/** The list's accessible name, and its heading. */
export const LESSONS_LABEL = "Lessons";

/** Where the list sends a producer for more (GRV-190). */
export const INSTAGRAM_URL = "https://www.instagram.com/trygroove.app";
export const INSTAGRAM_HANDLE = "@trygroove.app";

export interface LessonsListProps {
  readonly lesson: Lesson;
  /** The bites done in any project, by the profile. */
  readonly doneAnywhere: () => readonly string[];
  /** A row was pressed: start (or carry on with) that lesson. */
  onPick(lessonId: LessonId): void;
  /** The Instagram link was opened. */
  onInstagram(): void;
  /** Done: back to the conversation. */
  onDone(): void;
}

function Ticks(props: { readonly ticks: readonly Tick[] }): JSX.Element {
  return (
    <span class="lesson-ticks" aria-hidden="true">
      <For each={props.ticks}>{(tick) => <i data-tick={tick} />}</For>
    </span>
  );
}

/**
 * Every lesson, in place of the conversation (GRV-190, after
 * docs/assistant-panel.html, step 10): a row each, in `LESSONS`' order, with
 * its summary and how far this project has come with it, as the same ticks
 * the plan draws. The lesson under way says "Continue". Pressing a row starts
 * it with no message sent and no model turn; the model never decides whether
 * a lesson starts.
 */
export default function LessonsList(props: LessonsListProps): JSX.Element {
  let first: HTMLButtonElement | undefined;
  // Opened from the header's button, the list takes focus at its first row.
  onSettled(() => {
    first?.focus({ preventScroll: true });
  });
  return (
    <section class="assistant-panel-log lessons-list" aria-label={LESSONS_LABEL}>
      <div class="lessons-list-head">
        <h3>{LESSONS_LABEL}</h3>
        <p>
          Each one runs in your own project, a step at a time. Press one to start it, or
          to pick up where you left it.
        </p>
      </div>
      <For each={LESSONS}>
        {(each, index) => {
          const progress = () =>
            lessonProgress(
              each,
              props.lesson.finished(),
              props.doneAnywhere(),
              props.lesson.state(),
            );
          return (
            <button
              ref={(element) => {
                if (index() === 0) first = element;
              }}
              type="button"
              class="lessons-list-row"
              aria-current={progress().underWay ? "true" : undefined}
              onClick={() => props.onPick(each.id)}
            >
              <b class="lessons-list-title">{each.title}</b>
              <small class="lessons-list-summary">{each.summary}</small>
              <span class="lessons-list-progress">
                <Ticks ticks={progress().ticks} />
                <span class="lessons-list-state">{progress().text}</span>
                {progress().underWay ? (
                  <b class="lessons-list-continue">Continue</b>
                ) : null}
              </span>
            </button>
          );
        }}
      </For>
      <p class="lessons-list-more">
        More bite-sized lessons on Instagram: follow{" "}
        <a
          href={INSTAGRAM_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => props.onInstagram()}
        >
          {INSTAGRAM_HANDLE}
        </a>
        .
      </p>
      <div class="lessons-list-foot">
        <button
          type="button"
          class="memory-proposal-secondary"
          onClick={() => props.onDone()}
        >
          Done
        </button>
      </div>
    </section>
  );
}
