/**
 * What a lesson logs (GRV-43, GRV-44): `lesson_bite_started` with where it
 * was started from, `lesson_bite_completed` with how, `lesson_chapter_completed`,
 * `lesson_track_completed` once "Finish a track" ends on its stems, and
 * `feature_first_use` `lessons`, by chapter and bite ID only.
 */
import type { Analytics } from "../../analytics/analytics";
import type { LessonSource } from "../../lessons/ids";
import {
  biteOf,
  chapterOf,
  type LessonEvent,
  type LessonState,
} from "../../lessons/session";

type LessonAnalytics = Pick<Analytics, "log" | "logFeatureFirstUse">;

/** The chapter and bite `state` is on, as every `lesson_*` event names them. */
export function lessonIds(state: LessonState) {
  return { chapter_id: chapterOf(state).id, bite_id: biteOf(state).id };
}

/** A bite started from `source`. */
export function logStarted(
  analytics: LessonAnalytics,
  state: LessonState,
  source: LessonSource,
): void {
  analytics.log("lesson_bite_started", { ...lessonIds(state), source });
  analytics.logFeatureFirstUse("lessons");
}

/** A transition that left the lesson at `state`. */
export function logTransition(
  analytics: LessonAnalytics,
  state: LessonState,
  event: LessonEvent,
): void {
  if (event.kind !== "bite_done") return;
  analytics.log("lesson_bite_completed", { ...lessonIds(state), how: event.how });
  if (event.chapterDone) {
    analytics.log("lesson_chapter_completed", { chapter_id: chapterOf(state).id });
  }
  // The track is finished by exporting its stems, not by skipping that.
  if (event.lessonDone && state.lessonId === "track" && event.how !== "skipped") {
    analytics.log("lesson_track_completed", {});
  }
}
