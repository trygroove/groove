/**
 * Notes as the model writes them (GRV-131): a short array per note rather
 * than a whole domain note event.
 *
 * Most of what a sketch or an arrangement costs is the proposal's JSON, and
 * most of that was notes: every one a full `NoteEvent` (`id`, `trigger: {kind,
 * pitch}`, `startTicks`, `durationTicks`, `velocity`, `probability: null`),
 * about 40 output tokens each. `clip_create` and `note_add` take a note as
 * `[startTicks, pitch, durationTicks, velocity]` instead, a drum hit's pad ID
 * in place of the pitch and an optional fifth number for its probability, and
 * no ID at all.
 *
 * The gateway expands them ({@link createNoteExpander}) before a call joins
 * the proposal, minting each note's ID from the turn's ID stem in the order
 * the calls came ({@link gatewayNoteId}: a counter the model's own IDs do
 * not use, and one the gateway keeps to itself, refusing a note ID of the
 * model's in it and never minting one the model has taken), so the proposal
 * the browser validates, previews, applies,
 * undoes and keeps in a transcript is made of ordinary note events and
 * ordinary command payloads, exactly as before. The calls in an ask's
 * previews are written out the same way, in a counter of their own
 * ({@link expandAskPreviews}). Nothing outside the gateway ever sees a
 * compact note.
 *
 * A note already written out as an event (a scripted provider's, or the
 * model's despite the schema) is left as it is for the tool's own schema to
 * judge.
 */
import { z } from "zod";
import {
  clipLengthTickSchema,
  MAX_CLIP_LENGTH_BARS,
  MAX_CLIP_LENGTH_TICKS,
} from "../domain/clipLength";
import { clipContentSchema, clipSchema, type NoteEvent } from "../domain/entities";
import { ID_PREFIXES, padIdSchema } from "../domain/ids";
import {
  NOTE_PROBABILITY,
  NOTE_VELOCITY,
  parameterValueSchema,
} from "../domain/parameters";
import { durationTickSchema, tickSchema } from "../domain/time";
import type { AskOption, AssistantAsk } from "./ask";
import {
  type ClipLedger,
  copyContentSchema,
  duplicateCount,
  gatewayPlacementId,
  gatewayPlacementPattern,
  MAX_TURN_PLACEMENTS,
  rewriteClipCopy,
  rewritePlacement,
  withClipCall,
} from "./clipReuse";
import {
  type DrumSteps,
  drumStepsSchema,
  expandDrumSteps,
  isStepEntry,
  stepNoteEvent,
} from "./drumSteps";
import {
  expandGenerator,
  type GeneratorCall,
  generatorCallSchema,
  isGeneratorEntry,
} from "./generators";
import { NEW_ID_COUNTER_DIGITS } from "./prompt";
import type { AssistantToolCall } from "./protocol";
import type { RecommendationTargets } from "./recommendationTargets";

/** What the tools say a note is, wherever they take one. */
export const COMPACT_NOTE_DESCRIPTION =
  "A note: [startTicks, pitch, durationTicks, velocity], with a drum hit's pad ID in place of the MIDI pitch, and an optional fifth number for its probability. No ID: Groove gives each note its own.";

/** One note as the model writes it. */
export const compactNoteSchema = z
  .tuple([
    tickSchema,
    z.union([z.int().min(0).max(127), padIdSchema]),
    durationTickSchema,
    parameterValueSchema(NOTE_VELOCITY),
    parameterValueSchema(NOTE_PROBABILITY).nullable().optional(),
  ])
  // Nothing after the probability: the offered schema says so too.
  .rest(z.never())
  .describe(COMPACT_NOTE_DESCRIPTION)
  // Said outright as well, for a model that reads lengths before positions.
  .meta({ minItems: 4, maxItems: 5 });
export type CompactNote = z.infer<typeof compactNoteSchema>;

const compactNotesSchema = z.array(compactNoteSchema);

/** `clip_create`'s input as the model is offered it: a clip whose notes are compact. */
export const compactClipSchema = clipSchema.extend({
  content: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("notes"), events: compactNotesSchema }),
    // The audio-loop content, as the domain has it.
    ...clipContentSchema.options.filter((option) => option.shape.kind.value !== "notes"),
  ]),
});

/**
 * `clip_create`'s input as the model is offered it with the `drumStepStrings`
 * tactic on (GRV-140), the `patternGenerators` tactic on (GRV-141), or both: a
 * note is a compact note, a drum pad's step string, or a generator call.
 */
export function compactClipWithFormsSchema(forms: {
  readonly stepStrings: boolean;
  readonly generators: boolean;
  /** Whether content may copy another clip's notes (`clipReuse`, GRV-131). */
  readonly copies?: boolean;
}) {
  const entry: [z.ZodType, ...z.ZodType[]] = [
    compactNoteSchema,
    ...(forms.stepStrings ? [drumStepsSchema] : []),
    ...(forms.generators ? [generatorCallSchema] : []),
  ];
  const note = entry.length === 1 ? compactNoteSchema : z.union(entry);
  return clipSchema.extend({
    content: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("notes"),
        events: z.array(note),
      }),
      ...(forms.copies ? [copyContentSchema(note)] : []),
      ...clipContentSchema.options.filter(
        (option) => option.shape.kind.value !== "notes",
      ),
    ]),
  });
}

/** `clip_create` with step strings on alone (GRV-140). */
export const compactClipWithStepsSchema = compactClipWithFormsSchema({
  stepStrings: true,
  generators: false,
});
export type { DrumSteps, GeneratorCall };

/** `note_add`'s input as the model is offered it. */
export const compactNoteAddSchema = z.strictObject({
  clipId: clipSchema.shape.id,
  notes: compactNotesSchema.min(1),
});

/**
 * What starts the counter of a note ID the gateway mints. The model's new IDs
 * end in a counter of digits only (`prompt.ts`), notes_duplicate's included,
 * so a counter that starts with a letter is one it is never asked to make. A
 * model can still slip into it, counting on from the IDs it was told, so the
 * gateway refuses such an ID in a step it answers and never mints one a call
 * has taken (`createNoteExpander`).
 */
const GATEWAY_NOTE_MARK = "n";

/**
 * What starts the counter of a note ID the gateway mints in an ask's preview
 * (`ask_producer`'s `sound.calls`): a counter of its own, so a preview's notes
 * neither take from the proposal's numbering nor share an ID with a note the
 * proposal writes, should the producer apply that and then hear the preview.
 */
export const PREVIEW_NOTE_MARK = "p";

/** The digits after a note mark, so the ID keeps its length. */
const GATEWAY_NOTE_DIGITS = NEW_ID_COUNTER_DIGITS - GATEWAY_NOTE_MARK.length;

/** The most notes one turn may write: what the gateway's counter can number. */
export const MAX_TURN_NOTES = 10 ** GATEWAY_NOTE_DIGITS - 1;

const TOO_MANY_NOTES = `One proposal may write at most ${MAX_TURN_NOTES} notes; loop a short clip instead`;

/**
 * The `index`th note ID the gateway mints in a turn given `stem`, from 1, in
 * the counter `mark` starts (the proposal's unless told otherwise).
 */
export function gatewayNoteId(
  stem: string,
  index: number,
  mark: string = GATEWAY_NOTE_MARK,
): string {
  return `${ID_PREFIXES.event}_${stem}${mark}${String(index).padStart(GATEWAY_NOTE_DIGITS, "0")}`;
}

/** The pattern of every note ID the gateway mints in a turn given `stem` and `mark`. */
function gatewayNotePattern(stem: string, mark: string): RegExp {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${ID_PREFIXES.event}_${escaped}${mark}\\d{${GATEWAY_NOTE_DIGITS}}$`,
  );
}

/**
 * The note IDs `call` makes itself, rather than leaves to the gateway:
 * notes_duplicate's newIds, and the ID of a note it wrote out as an event.
 */
export function modelNoteIds(call: AssistantToolCall): string[] {
  if (!isRecord(call.input)) return [];
  if (call.name === "notes_duplicate") {
    const { newIds } = call.input;
    return Array.isArray(newIds)
      ? newIds.filter((id): id is string => typeof id === "string")
      : [];
  }
  const at = NOTE_FIELDS[call.name]?.(call.input);
  if (!at || !Array.isArray(at.notes)) return [];
  return at.notes.flatMap((note) =>
    isRecord(note) && typeof note.id === "string" ? [note.id] : [],
  );
}

/** A call with its compact notes written out, or why they could not be. */
export type ExpandedCall =
  | {
      readonly ok: true;
      readonly call: AssistantToolCall;
      /** The IDs given to the notes it wrote out, in the order it gave them. */
      readonly noteIds: readonly string[];
      /** The ID given to the placement it made, when the gateway gave it one (`clipReuse`). */
      readonly placementId?: string;
    }
  | { readonly ok: false; readonly message: string };

/** Why an expanded call is refused, or null when it is accepted. */
export type ExpandedCheck = (call: AssistantToolCall) => string | null;

/** Where each tool that takes notes keeps them in its input. */
const NOTE_FIELDS: Readonly<Record<string, (input: Record<string, unknown>) => NotesAt>> =
  {
    clip_create: (input) => {
      const content = input.content as Record<string, unknown> | undefined;
      if (!isRecord(content) || content.kind !== "notes") return null;
      return {
        notes: content.events,
        path: "content.events",
        clip: { trackId: input.trackId, lengthTicks: input.lengthTicks },
        write: (events) => ({ ...input, content: { ...content, events } }),
      };
    },
    note_add: (input) => ({
      notes: input.notes,
      path: "notes",
      write: (notes) => ({ ...input, notes }),
    }),
  };

/** The clip a step string or a generator call fills, its length checked. */
interface ClipFill {
  readonly trackId: string;
  readonly lengthTicks: number;
  readonly pads: ReadonlySet<string> | undefined;
}

type NotesAt = {
  readonly notes: unknown;
  readonly path: string;
  /** The clip the notes go in, when the call makes it: what a step string fills. */
  readonly clip?: { readonly trackId: unknown; readonly lengthTicks: unknown };
  readonly write: (notes: unknown[]) => Record<string, unknown>;
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One compact note as the domain note event it stands for. */
export function noteEventOf(note: CompactNote, id: string): NoteEvent {
  const [startTicks, sound, durationTicks, velocity, probability] = note;
  return {
    id: id as NoteEvent["id"],
    trigger:
      typeof sound === "number"
        ? { kind: "pitch", pitch: sound }
        : { kind: "pad", padId: sound },
    startTicks,
    durationTicks,
    velocity,
    probability: probability ?? null,
  };
}

export interface NoteExpander {
  /**
   * `call` with every compact note it carries written out as a note event
   * with a new ID, or why one of them is not a note. A call that carries
   * none comes back as it is.
   *
   * `check`, when given, judges the written-out call; one it refuses comes
   * back refused, and only a call it accepts uses up note IDs, so a refused
   * call sent again corrected gets the IDs it would have had.
   */
  expand(call: AssistantToolCall, check?: ExpandedCheck): ExpandedCall;
  /**
   * Why `call` may not join the proposal for a note ID it makes itself in
   * the gateway's counter, or null when it makes none there. A step that is
   * answered refuses such a call, so the model's IDs and the gateway's stay
   * apart and the IDs the gateway reports count up without a gap.
   */
  refuseGatewayIds(call: AssistantToolCall): string | null;
  /**
   * Why `call` may not join the proposal for a note ID it makes itself that
   * the gateway has already given a note, or null when it makes none.
   */
  refuseMintedIds(call: AssistantToolCall): string | null;
  /**
   * Holds back the note IDs `calls` make themselves, so none is minted for a
   * note they write: for the last step, which nothing answers, before any of
   * its calls is expanded.
   */
  reserve(calls: readonly AssistantToolCall[]): void;
  /**
   * An expander that starts where this one is and goes on apart from it: what
   * a step's calls would come to, worked out without numbering the turn's
   * notes.
   */
  fork(): NoteExpander;
}

/**
 * What the expander needs to write out drum step strings (GRV-140) and
 * pattern generator calls (GRV-141): the tracks and pads the turn starts
 * with, how a call it accepts changes them (`withCreatedTargets`, handed in
 * so this module needs nothing of `tools.ts`), and which of the two forms its
 * tactics offer. Without it, neither is expanded at all: the tactics are off,
 * and the tool's own schema refuses either.
 */
export interface StepStringOptions {
  readonly targets: RecommendationTargets;
  readonly track: (
    targets: RecommendationTargets,
    call: AssistantToolCall,
  ) => RecommendationTargets;
  /** Whether a step string is written out (`drumStepStrings`); true when not said. */
  readonly stepStrings?: boolean;
  /** Whether a generator call is written out (`patternGenerators`); false when not said. */
  readonly generators?: boolean;
  /**
   * The clips the turn starts knowing, when the `clipReuse` tactic is on
   * (GRV-131): a short placement, a copied clip and a notes_duplicate with no
   * newIds are written out (`clipReuse.ts`). Left out, none of them is.
   */
  readonly clipReuse?: ClipLedger;
}

/** Where one turn's expander is: what it has numbered and what it knows. */
interface ExpanderState {
  counter: number;
  targets: RecommendationTargets;
  /** The calls accepted so far: a generator call's position in the turn, for its seed. */
  accepted: number;
  /** Note IDs the turn's calls hold, minted or the model's own. */
  readonly taken: Set<string>;
  /** The note IDs the gateway has given out. */
  readonly minted: Set<string>;
  /** The clips the turn knows (`clipReuse`). */
  clips: ClipLedger;
  /** The placements the gateway has numbered (`clipReuse`). */
  placements: number;
  /** Placement IDs the turn's accepted calls make. */
  readonly placementIds: Set<string>;
}

function copyState(state: ExpanderState): ExpanderState {
  return {
    ...state,
    taken: new Set(state.taken),
    minted: new Set(state.minted),
    placementIds: new Set(state.placementIds),
  };
}

/**
 * The expander for one turn: note IDs come from `stem` as every other new ID
 * the turn makes does, in a counter of their own ({@link gatewayNoteId}),
 * counted up across the turn in the order the calls are accepted, so the same
 * calls always expand to the same notes.
 */
export function createNoteExpander(
  stem: string,
  mark: string = GATEWAY_NOTE_MARK,
  stepStrings?: StepStringOptions,
  from?: ExpanderState,
): NoteExpander {
  const pattern = gatewayNotePattern(stem, mark);
  const placementPattern = gatewayPlacementPattern(stem, mark);
  const state: ExpanderState = from ?? {
    counter: 0,
    targets: stepStrings?.targets ?? new Map(),
    accepted: 0,
    taken: new Set(),
    minted: new Set(),
    clips: stepStrings?.clipReuse ?? new Map(),
    placements: 0,
    placementIds: new Set(),
  };
  const { taken, minted } = state;
  /** Whether the model's step strings, and its generator calls, are written out. */
  const writesSteps = stepStrings !== undefined && stepStrings.stepStrings !== false;
  const writesGenerators = stepStrings?.generators === true;
  /** Whether short placements, copies and duplicates with no IDs are written out. */
  const reuses = stepStrings?.clipReuse !== undefined;
  /** Whether `note` is one the gateway writes out. */
  const isCompact = (note: unknown) =>
    Array.isArray(note) ||
    (writesSteps && isStepEntry(note)) ||
    (writesGenerators && isGeneratorEntry(note));
  /** The next free note ID after `from`, and the counter it was minted at. */
  const nextFree = (from: number): { id: string; at: number } | null => {
    for (let at = from + 1; at <= MAX_TURN_NOTES; at += 1) {
      const id = gatewayNoteId(stem, at, mark);
      if (!taken.has(id)) return { id, at };
    }
    return null;
  };
  return {
    refuseGatewayIds(call) {
      const clashing = modelNoteIds(call).filter((id) => pattern.test(id));
      if (clashing.length === 0) return null;
      return `${idList(clashing)}: a note ID with "${mark}" before its number is one Groove gives the notes you write. Make the note IDs you need from the stem with a ${NEW_ID_COUNTER_DIGITS}-digit number, as every new ID, e.g. ${ID_PREFIXES.event}_${stem}${"1".padStart(NEW_ID_COUNTER_DIGITS, "0")}`;
    },
    refuseMintedIds(call) {
      const clashing = modelNoteIds(call).filter((id) => minted.has(id));
      if (clashing.length === 0) return null;
      return `${idList(clashing)}: Groove has already given ${clashing.length === 1 ? "that ID" : "those IDs"} to a note you wrote`;
    },
    reserve(calls) {
      for (const call of calls) for (const id of modelNoteIds(call)) taken.add(id);
    },
    fork() {
      return createNoteExpander(stem, mark, stepStrings, copyState(state));
    },
    expand(sent, check) {
      let call = sent;
      if (reuses && isRecord(sent.input)) {
        if (sent.name === "placement_create")
          return expandPlacement(sent, sent.input, check);
        if (sent.name === "notes_duplicate" && sent.input.newIds === undefined) {
          return expandDuplicate(sent, sent.input, check);
        }
        if (sent.name === "clip_create") {
          const copy = rewriteClipCopy(sent.input, state.clips);
          if (!copy.ok) return refusedCall(copy.reason);
          call = { ...sent, input: copy.input };
        }
      }
      const field = isRecord(call.input) ? NOTE_FIELDS[call.name] : undefined;
      const at = field && isRecord(call.input) ? field(call.input) : null;
      if (!at || !Array.isArray(at.notes) || !at.notes.some(isCompact)) {
        const refused = check?.(call) ?? null;
        if (refused !== null) return refusedCall(refused);
        return accept(call, [], sent);
      }
      const events: unknown[] = [];
      const noteIds: string[] = [];
      let next = state.counter;
      /** Gives `event` (an event awaiting its ID) the next free note ID, or false when none is left. */
      const mint = (event: (id: string) => NoteEvent): boolean => {
        const free = nextFree(next);
        if (free === null) return false;
        next = free.at;
        noteIds.push(free.id);
        events.push(event(free.id));
        return true;
      };
      /** The clip the notes go in, checked: what a step string or a generator fills. */
      const clipOf = (where: string, form: string): string | ClipFill => {
        if (!at.clip) {
          return `${where}: a ${form} goes in clip_create's content.events; ${call.name} takes notes as arrays`;
        }
        const length = clipLengthTickSchema.safeParse(at.clip.lengthTicks);
        if (!length.success) {
          return `lengthTicks: a clip is a whole number of ticks from 1 to ${MAX_CLIP_LENGTH_TICKS} (${MAX_CLIP_LENGTH_BARS} bars); its ${form}s fill it`;
        }
        const trackId = typeof at.clip.trackId === "string" ? at.clip.trackId : "";
        return { trackId, lengthTicks: length.data, pads: state.targets.get(trackId) };
      };
      /** Writes a step string out into `events`, or says why it is refused. */
      const writeSteps = (
        entry: unknown,
        where: string,
        clip: ClipFill,
      ): string | null => {
        const expansion = expandDrumSteps(entry, {
          ...clip,
          maxHits: MAX_TURN_NOTES - next,
        });
        if (!expansion.ok) {
          const at = expansion.field === null ? "" : `.${expansion.field}`;
          return `${where}${at}: ${expansion.reason}`;
        }
        for (const hit of expansion.hits) {
          if (!mint((id) => stepNoteEvent(hit, id))) return TOO_MANY_NOTES;
        }
        return null;
      };
      /** Writes a compact note out into `events`, or says why it is refused. */
      const writeNote = (note: readonly unknown[], where: string): string | null => {
        const parsed = compactNoteSchema.safeParse(note);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const path = [where, ...(issue?.path ?? [])].join(".");
          return `${path}: ${issue?.message ?? "not a note"}; a note is [startTicks, pitch or padId, durationTicks, velocity]`;
        }
        return mint((id) => noteEventOf(parsed.data, id)) ? null : TOO_MANY_NOTES;
      };
      for (const [index, note] of at.notes.entries()) {
        const where = `${at.path}.${index}`;
        if (writesGenerators && isGeneratorEntry(note)) {
          const clip = clipOf(where, "generator call");
          if (typeof clip === "string") return refusedCall(clip);
          const expansion = expandGenerator(note, {
            ...clip,
            seed: `${stem}${mark}:${state.accepted}:${index}`,
            maxNotes: MAX_TURN_NOTES - next,
          });
          if (!expansion.ok) {
            const at = expansion.field === null ? "" : `.${expansion.field}`;
            return refusedCall(`${where}${at}: ${expansion.reason}`);
          }
          for (const entry of expansion.entries) {
            const refused = Array.isArray(entry)
              ? writeNote(entry, where)
              : writeSteps(entry, where, clip);
            if (refused !== null) return refusedCall(refused);
          }
          continue;
        }
        if (writesSteps && isStepEntry(note)) {
          const clip = clipOf(where, "step string");
          if (typeof clip === "string") return refusedCall(clip);
          const refused = writeSteps(note, where, clip);
          if (refused !== null) return refusedCall(refused);
          continue;
        }
        if (!Array.isArray(note)) {
          events.push(note);
          continue;
        }
        const refused = writeNote(note, where);
        if (refused !== null) return refusedCall(refused);
      }
      const expanded = { ...call, input: at.write(events) };
      const refused = check?.(expanded) ?? null;
      if (refused !== null) return refusedCall(refused);
      state.counter = next;
      return accept(expanded, noteIds, sent);
    },
  };

  /**
   * A `placement_create` written out whole (`clipReuse`): a short one given
   * the next placement ID, its clip's track and the defaults. One that makes
   * an ID in the gateway's counter is refused, as a note's is.
   */
  function expandPlacement(
    sent: AssistantToolCall,
    input: Record<string, unknown>,
    check: ExpandedCheck | undefined,
  ): ExpandedCall {
    if (typeof input.id === "string" && placementPattern.test(input.id)) {
      return refusedCall(
        `id: a placement ID with "${mark}" before its number is one Groove gives; leave id out, or make it from the stem with a ${NEW_ID_COUNTER_DIGITS}-digit number`,
      );
    }
    let at = state.placements + 1;
    while (
      at <= MAX_TURN_PLACEMENTS &&
      state.placementIds.has(gatewayPlacementId(stem, at, mark))
    ) {
      at += 1;
    }
    const minted = gatewayPlacementId(stem, at, mark);
    const rewritten = rewritePlacement(input, state.clips, minted);
    if (!rewritten.ok) return refusedCall(rewritten.reason);
    const gave = input.id === undefined && rewritten.input.id === minted;
    if (gave && at > MAX_TURN_PLACEMENTS) {
      return refusedCall(
        `One proposal may place at most ${MAX_TURN_PLACEMENTS} clips without their IDs; give the rest an id`,
      );
    }
    const call = { ...sent, input: rewritten.input };
    const refused = check?.(call) ?? null;
    if (refused !== null) return refusedCall(refused);
    if (gave) state.placements = at;
    return accept(call, [], sent, gave ? minted : undefined);
  }

  /**
   * A `notes_duplicate` with no `newIds` given them (`clipReuse`): one note ID
   * per note it copies, from the turn's note counter.
   */
  function expandDuplicate(
    sent: AssistantToolCall,
    input: Record<string, unknown>,
    check: ExpandedCheck | undefined,
  ): ExpandedCall {
    const count = duplicateCount(input, state.clips);
    if (typeof count === "string") return refusedCall(count);
    const noteIds: string[] = [];
    let next = state.counter;
    for (let index = 0; index < count; index += 1) {
      const free = nextFree(next);
      if (free === null) return refusedCall(TOO_MANY_NOTES);
      next = free.at;
      noteIds.push(free.id);
    }
    const call = { ...sent, input: { ...input, newIds: noteIds } };
    const refused = check?.(call) ?? null;
    if (refused !== null) return refusedCall(refused);
    state.counter = next;
    return accept(call, noteIds, sent);
  }

  /**
   * `call` accepted: the note IDs it holds, the gateway's and the model's
   * own (read off the call as the model sent it), are taken from now on.
   */
  function accept(
    call: AssistantToolCall,
    noteIds: readonly string[],
    sent: AssistantToolCall = call,
    placementId?: string,
  ): ExpandedCall {
    for (const id of noteIds) minted.add(id);
    for (const id of [...noteIds, ...modelNoteIds(sent)]) taken.add(id);
    if (stepStrings) state.targets = stepStrings.track(state.targets, call);
    if (reuses) {
      state.clips = withClipCall(state.clips, call);
      if (call.name === "placement_create" && isRecord(call.input)) {
        if (typeof call.input.id === "string") state.placementIds.add(call.input.id);
      }
    }
    state.accepted += 1;
    return placementId === undefined
      ? { ok: true, call, noteIds }
      : { ok: true, call, noteIds, placementId };
  }
}

/**
 * `ask` with the compact notes in its options' previews written out, as the
 * proposal's are: a preview is "the same calls as a proposal", and the
 * browser validates it as one before the producer can hear it (GRV-4).
 *
 * Each preview numbers its notes in a counter of its own
 * ({@link PREVIEW_NOTE_MARK}), counted from 1 and kept clear of the note IDs
 * its calls make themselves: a preview is never applied to the project, and
 * is heard on its own, so its IDs need only be valid and unique within it. A
 * call whose notes are not notes goes on as it came, and the browser refuses
 * that preview as it refuses any call that does not fit its tool.
 */
export function expandAskPreviews(
  ask: AssistantAsk,
  stem: string,
  stepStrings?: StepStringOptions,
): AssistantAsk {
  if (!ask.options.some((option) => option.sound?.kind === "preview")) return ask;
  return {
    ...ask,
    options: ask.options.map((option) => expandPreview(option, stem, stepStrings)),
  };
}

function expandPreview(
  option: AskOption,
  stem: string,
  stepStrings: StepStringOptions | undefined,
): AskOption {
  const sound = option.sound;
  if (sound?.kind !== "preview") return option;
  const notes = createNoteExpander(stem, PREVIEW_NOTE_MARK, stepStrings);
  const asCall = (call: (typeof sound.calls)[number]): AssistantToolCall => ({
    id: "preview",
    ...call,
  });
  notes.reserve(sound.calls.map(asCall));
  const calls = sound.calls.map((call) => {
    const expanded = notes.expand(asCall(call));
    return expanded.ok
      ? { name: call.name, input: expanded.call.input as typeof call.input }
      : call;
  });
  return { ...option, sound: { ...sound, calls } };
}

/** The most IDs a refusal names before it counts the rest. */
const NAMED_IDS = 5;

/**
 * `ids` as a refusal names them: the first few and how many more, so a call
 * that clashes everywhere still gets a reason short enough to send.
 */
function idList(ids: readonly string[]): string {
  const named = ids.slice(0, NAMED_IDS).join(", ");
  const rest = ids.length - NAMED_IDS;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

function refusedCall(message: string): ExpandedCall {
  return { ok: false, message };
}
