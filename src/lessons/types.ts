/**
 * The shape of a lesson (GRV-43): a chapter is a few bites, a bite is one
 * skill in a few minutes, and a bite is one or more steps. Each step says
 * what to do, where to do it, how to tell it is done, and what Show me does.
 *
 * A step is read against a {@link LessonWorld}: the producer's real project
 * and the little of the editor a lesson needs (the view on screen, the
 * transport, the master meter, the stems exported). Everything here is pure,
 * so a step's predicate is tested as a function over a project.
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
  /** The bar the playhead is in, from 0 (GRV-44). */
  readonly bar: number;
  /**
   * How many bars the playhead has moved into since the song last started
   * playing (GRV-44): what "listen for four bars" counts, loops and all.
   */
  readonly barsHeard: number;
  /**
   * How many times the master meter has gone red since the song last started
   * playing (GRV-44).
   */
  readonly masterClips: number;
  /** How many stem exports the producer has started in this editor (GRV-44). */
  readonly stemExports: number;
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
 * - `play`: starts the song, from `from` (in ticks) when it says.
 * - `sound`: puts a sound of `role` from the library on a pad, as the
 *   Library's own insert does. Which sound is the library's to say, so the
 *   editor picks one the pad is not already playing.
 * - `export`: opens the Export dialog with stems chosen and every track in
 *   them (GRV-44); exporting is still the producer's press.
 */
export type ShowMe =
  | { readonly kind: "commands"; readonly commands: readonly RawCommandInput[] }
  | { readonly kind: "view"; readonly view: EditorViewName }
  | { readonly kind: "play"; readonly from?: number }
  | { readonly kind: "export" }
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
  /**
   * Whether Show me runs as the step starts (GRV-44), for a step whose Show
   * me only opens where to act (the Export dialog): it is not the step done,
   * so the step is still the producer's.
   */
  readonly showsAtStart?: boolean;
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
  /**
   * Whether the song already has what the bite makes (GRV-44), so "Finish a
   * track" passes over it: a beat the producer made before, or a key they
   * already chose. Read once, as its chapter starts. Without it, the bite is
   * always taught.
   */
  made?(world: LessonWorld, settings: LessonSettings): boolean;
}

export interface LessonChapter {
  readonly id: ChapterId;
  readonly title: string;
  /** What it makes, in a few words. */
  readonly summary: string;
  readonly bites: readonly LessonBite[];
}
