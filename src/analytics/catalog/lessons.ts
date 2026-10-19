// Lessons with Coproducer (GRV-43): bite-sized chapters taught in the
// producer's own project, and the daily nudge that names the next bite.
//
// Every parameter is one of our own IDs (`src/lessons/ids.ts`): which chapter
// and bite, how a bite ended and where it was started from. Never a step's
// words, a project's content or anything Coproducer said.

import { BITE_ENDINGS, BITE_IDS, CHAPTER_IDS, LESSON_SOURCES } from "../../lessons/ids";
import { type AnalyticsEventDefinition, enumParam } from "./params";

/** Lessons' `feature_first_use` keys (see `FEATURE_KEYS`). */
export const LESSON_FEATURE_KEYS = ["lessons"] as const;

const bite = {
  chapter_id: enumParam(CHAPTER_IDS),
  bite_id: enumParam(BITE_IDS),
};

export const LESSON_EVENTS = {
  // A bite under way, and where it was started from: the producer asking,
  // the offer at the end of onboarding, the daily nudge, or "Next" after the
  // bite before.
  lesson_bite_started: {
    phase: 3,
    owners: ["GRV-43"],
    params: { ...bite, source: enumParam(LESSON_SOURCES) },
  },

  // A bite over: done by the producer, shown by Show me, or skipped.
  lesson_bite_completed: {
    phase: 3,
    owners: ["GRV-43"],
    params: { ...bite, how: enumParam(BITE_ENDINGS) },
  },

  // The producer left the lesson part-way, during this bite.
  lesson_dropped_out: {
    phase: 3,
    owners: ["GRV-43"],
    params: bite,
  },

  // The daily "Want to try…?" offered the next unfinished bite, and the
  // producer took it.
  lesson_nudge_shown: {
    phase: 3,
    owners: ["GRV-43"],
    params: bite,
  },

  lesson_nudge_taken: {
    phase: 3,
    owners: ["GRV-43"],
    params: bite,
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;
