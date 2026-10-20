/**
 * The shape of a lesson (GRV-43): a chapter is a few bites, a bite is one
 * skill in a few minutes, and a bite is one or more steps. Each step says
 * what to do, where to do it, how to tell it is done, and what Show me does.
 *
 * A step is read against a {@link LessonWorld}: the producer's real project
 * and the little of the editor a lesson needs (the view on screen, whether
 * the song is playing). Everything here is pure, so a step's predicate is
 * tested as a function over a project.
 */
import type { EditorViewName } from "../analytics/catalog";
import type { ControlAddress } from "../commands/controlAddress";
import type { RawCommandInput } from "../commands/types";
import type { Project } from "../domain/entities";
import type { DomainFactoryContext } from "../domain/factories";
import type { PadId, TrackId } from "../domain/ids";
import type { BiteId, ChapterId } from "./ids";
import type { BeatStyle } from "./style";

/** What a step reads: the project, and where the editor is. */
export interface LessonWorld {
  readonly project: Project;
  readonly view: EditorViewName;
  readonly playing: boolean;
}

/** What a lesson knows about the producer, from memory. */
export interface LessonSettings {
  /** The beat the "Make a beat" chapter teaches. */
  readonly style: BeatStyle;
}

/**
 * What Show me does for a step, against the world as it is.
 *
 * - `commands`: applies them as one undoable change, as the assistant.
 * - `view`: goes to that view.
 * - `play`: starts the song.
 * - `sound`: puts a sound of `role` from the library on a pad, as the
 *   Library's own insert does. Which sound is the library's to say, so the
 *   editor picks one the pad is not already playing.
 */
export type ShowMe =
  | { readonly kind: "commands"; readonly commands: readonly RawCommandInput[] }
  | { readonly kind: "view"; readonly view: EditorViewName }
  | { readonly kind: "play" }
  | {
      readonly kind: "sound";
      readonly role: "kick";
      readonly trackId: TrackId;
      readonly padId: PadId;
    };

export interface LessonStep {
  /** Unique within its bite. */
  readonly id: string;
  /**
   * Whether the step is part of the bite for this world. A step that does
   * not apply (a synth track to add, when there is one) is passed over.
   * Read once, as the step would start.
   */
  applies?(world: LessonWorld, settings: LessonSettings): boolean;
  /**
   * What to do, in a sentence or two, with each term written
   * `[words](term-id)` (`glossary.ts`). Read once, as the step starts, so it
   * can name the producer's own tracks.
   */
  instruction(world: LessonWorld, settings: LessonSettings): string;
  /** The control to mark where to act, or null when there is none to mark. */
  target(world: LessonWorld, settings: LessonSettings): ControlAddress | null;
  /**
   * The step's predicate: whether it is done in `world`, given `start`, the
   * world as the step began.
   */
  done(world: LessonWorld, start: LessonWorld, settings: LessonSettings): boolean;
  /** What Show me does now, or null when it has nothing it can do. */
  showMe(
    world: LessonWorld,
    settings: LessonSettings,
    context: DomainFactoryContext,
  ): ShowMe | null;
}

export interface LessonBite {
  readonly id: BiteId;
  readonly chapter: ChapterId;
  readonly title: string;
  /** The one skill it teaches, as Coproducer is told it. */
  readonly skill: string;
  /** The quiz question Coproducer may ask once it is done, and its answer. */
  readonly quiz: string;
  readonly steps: readonly LessonStep[];
}

export interface LessonChapter {
  readonly id: ChapterId;
  readonly title: string;
  /** What it makes, in a few words. */
  readonly summary: string;
  readonly bites: readonly LessonBite[];
}
