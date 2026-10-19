// Helpers for the lessons' tests (GRV-43): a world over the starter project,
// and applying a step's Show me through the command kernel, as the editor
// does, so a test proves the commands are ones the kernel accepts.

import { executeTransaction } from "../commands/execute";
import type { Project } from "../domain/entities";
import { createFactoryContext, type DomainFactoryContext } from "../domain/factories";
import { createSeededIdFactory } from "../domain/ids";
import { createStarterProject } from "../editor/starterProject";
import type { LessonWorld, ShowMe } from "../lessons/types";

/** The starter project a new producer opens: BD with four on the floor. */
export function starterWorld(overrides: Partial<LessonWorld> = {}): LessonWorld {
  return {
    project: createStarterProject("owner-1", () => 0.5),
    view: "arrangement",
    playing: false,
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
      return { ...world, playing: true };
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
