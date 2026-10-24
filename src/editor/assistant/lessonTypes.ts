/**
 * What the lesson hook takes and gives (GRV-43, GRV-190): `useLesson.ts`
 * holds the signals and the wiring, and these are its edges, which the panel
 * and the lesson plan read.
 */
import type { Accessor } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { AssistantLessonContext } from "../../assistant/lesson";
import type { ControlRegistry } from "../../controls/registry";
import type { Project } from "../../domain/entities";
import type { DomainFactoryContext } from "../../domain/factories";
import type { BiteEnding, BiteId, LessonId, LessonSource } from "../../lessons/ids";
import type { LessonState } from "../../lessons/session";
import type { ProducerProfileStore } from "../../memory/useProducerProfile";
import type { EditorViewName } from "../composition/editorViews";
import type { AssistantConversation } from "./useAssistantConversation";
import type { LessonListening } from "./useLessonListening";
import type { LessonRecordStore } from "./useLessonRecord";
import type { LessonEditorPort } from "./useLessonShowMe";

export interface UseLessonOptions {
  /** The committed project, never a preview of it. */
  readonly project: Accessor<Project | null>;
  readonly view: Accessor<EditorViewName>;
  readonly playing: Accessor<boolean>;
  /** What "Finish a track" listens for (GRV-44); each reads 0 without one. */
  readonly listening?: LessonListening;
  /** What the beat style is read from, and the bites done across projects. */
  readonly profile?: ProducerProfileStore;
  /** The project's lesson record; without one, nothing is kept. */
  readonly record?: LessonRecordStore;
  readonly conversation: Pick<AssistantConversation, "sendLesson" | "streaming">;
  /** Without one, Show me has nothing to do. */
  readonly editor?: LessonEditorPort;
  /** Where the step's control is marked. */
  readonly registry?: Pick<ControlRegistry, "setMark">;
  readonly analytics: () => Pick<Analytics, "log" | "logFeatureFirstUse">;
  /** Makes Show me's new IDs; fresh ones by default. */
  readonly factoryContext?: () => DomainFactoryContext;
  /** Hears that the lesson ended or was left (GRV-190), so its quiz can go. */
  readonly onEnded?: () => void;
  /**
   * Hears that a lesson began from `source`: started, not carried on where it
   * is, and not held for the record's read until it actually begins.
   */
  readonly onStarted?: (lesson: LessonId, source: LessonSource) => void;
}

export interface Lesson {
  /** The lesson under way, or null outside one. */
  readonly state: Accessor<LessonState | null>;
  /** How each bite finished in this project ended (the record's). */
  readonly finished: Accessor<Partial<Record<BiteId, BiteEnding>>>;
  /** A word after Show me could not do anything. */
  readonly notice: Accessor<string | null>;
  /** Whether Show me has an editor to work in. */
  readonly canShowMe: boolean;
  /** Whether Show me is still at work, so cannot be pressed again yet. */
  readonly busy: Accessor<boolean>;
  /** Opens the view a step's term names (GRV-190). */
  openView(view: EditorViewName): void;
  /**
   * Starts `lesson` where the record has it under way, or from its first
   * bite (at `biteId` when given); whether it could (not while no project is
   * open). Another lesson under way is left first, its quiz put away; this
   * one, asked for again with no bite, carries on where it is. Asked for
   * while the project's record is still being read, it starts once the read
   * is over, from what the record has.
   */
  start(lesson: LessonId, source: LessonSource, biteId?: BiteId): boolean;
  /** The next bite, once the one before is over. */
  next(): void;
  /** Where {@link next} would go now, past what the song has; null for nowhere. */
  upcoming(): LessonState | null;
  showMe(): void;
  skip(): void;
  /** Leaves the lesson part-way. */
  leave(): void;
  /** The lesson as a turn the producer writes mid-lesson carries it. */
  context(): AssistantLessonContext | null;
}
