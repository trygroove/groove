// Helpers for the lessons' tests (GRV-43): a world over the starter project,
// and applying a step's Show me through the command kernel, as the editor
// does, so a test proves the commands are ones the kernel accepts.

import { executeTransaction } from "../commands/execute";
import type { Project } from "../domain/entities";
import { createFactoryContext, type DomainFactoryContext } from "../domain/factories";
import { createSeededIdFactory } from "../domain/ids";
import { TICKS_PER_BAR } from "../domain/time";
import { createStarterProject } from "../editor/composition/starterProject";
import { nextStep } from "../lessons/chapters";
import type { BiteId, LessonId } from "../lessons/ids";
import { type LessonTransition, startLesson } from "../lessons/session";
import type { LessonBite, LessonSettings, LessonWorld, ShowMe } from "../lessons/types";

/** A world over `project`, at rest on the arrangement. */
export function worldOf(
  project: Project,
  overrides: Partial<LessonWorld> = {},
): LessonWorld {
  return { ...starterWorld(overrides), project };
}

/** The starter project a new producer opens: BD with four on the floor. */
export function starterWorld(overrides: Partial<LessonWorld> = {}): LessonWorld {
  return {
    project: createStarterProject("owner-1", () => 0.5),
    view: "arrangement",
    playing: false,
    bar: 0,
    barsHeard: 0,
    masterClips: 0,
    stemExports: 0,
    ...overrides,
  };
}

/** A seeded factory context, so Show me's new IDs are deterministic. */
export function lessonContext(seed = 43): DomainFactoryContext {
  return createFactoryContext({ ids: createSeededIdFactory(seed), now: 1 });
}

/** Applies a Show me to `world` as the editor would, or throws. */
export function applyShowMe(world: LessonWorld, shown: ShowMe | null): LessonWorld {
  if (!shown) throw new Error("Show me had nothing to do");
  switch (shown.kind) {
    case "view":
      return { ...world, view: shown.view };
    case "play":
      return {
        ...world,
        playing: true,
        bar:
          shown.from === undefined ? world.bar : Math.floor(shown.from / TICKS_PER_BAR),
        barsHeard: 0,
        masterClips: 0,
      };
    case "export":
      return world;
    case "sound":
      throw new Error("A library sound is the editor's to put on a pad");
    case "commands": {
      const result = executeTransaction(world.project, shown.commands, {
        actor: "assistant",
      });
      if (!result.ok) {
        throw new Error(`Show me was refused: ${JSON.stringify(result.issues)}`);
      }
      return { ...world, project: result.project };
    }
  }
}

/** `project` changed by `commands`, or throws. */
export function applied(
  project: Project,
  commands: Parameters<typeof executeTransaction>[1],
): Project {
  const result = executeTransaction(project, commands);
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.issues)}`);
  return result.project;
}

let showSeed = 5_000;

/**
 * Every applicable step of `bite`, each done by its Show me, from `world`
 * (GRV-44); throws when a step's Show me leaves it undone. A play runs on
 * for four bars with the master clean, and an export is pressed.
 */
export function showBite(
  bite: LessonBite,
  world: LessonWorld,
  settings: LessonSettings,
): LessonWorld {
  let now = world;
  let at = nextStep(bite, now, settings);
  while (at) {
    const start = now;
    const shown = at.step.showMe(now, settings, lessonContext(showSeed++));
    if (shown?.kind === "export") now = { ...now, stemExports: now.stemExports + 1 };
    else {
      now = applyShowMe(now, shown);
      if (shown?.kind === "play") now = { ...now, bar: now.bar + 4, barsHeard: 4 };
    }
    if (!at.step.done(now, start, settings)) {
      throw new Error(`${bite.id}: Show me did not finish "${at.step.id}"`);
    }
    now = { ...now, playing: false };
    at = nextStep(bite, now, settings, at.index);
  }
  return now;
}

/**
 * Lesson `lessonId` started fresh at `biteId` (its first bite, with null),
 * as `startLesson` starts it with no record; throws when it does not start.
 */
export function startedAt(
  lessonId: LessonId,
  biteId: BiteId | null,
  world: LessonWorld,
  settings: LessonSettings,
): LessonTransition {
  const started = startLesson(lessonId, null, world, settings, biteId ?? undefined);
  if (!started) throw new Error(`"${lessonId}" did not start`);
  return started;
}
