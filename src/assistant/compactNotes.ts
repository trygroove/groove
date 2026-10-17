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
import { clipContentSchema, clipSchema, type NoteEvent } from "../domain/entities";
import { ID_PREFIXES, padIdSchema } from "../domain/ids";
import {
  NOTE_PROBABILITY,
  NOTE_VELOCITY,
  parameterValueSchema,
} from "../domain/parameters";
import { durationTickSchema, tickSchema } from "../domain/time";
import type { AskOption, AssistantAsk } from "./ask";
import { NEW_ID_COUNTER_DIGITS } from "./prompt";
import type { AssistantToolCall } from "./protocol";

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
        write: (events) => ({ ...input, content: { ...content, events } }),
      };
    },
    note_add: (input) => ({
      notes: input.notes,
      path: "notes",
      write: (notes) => ({ ...input, notes }),
    }),
  };

type NotesAt = {
  readonly notes: unknown;
  readonly path: string;
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
): NoteExpander {
  const pattern = gatewayNotePattern(stem, mark);
  let counter = 0;
  /** Note IDs the turn's calls hold, minted or the model's own. */
  const taken = new Set<string>();
  /** The note IDs the gateway has given out. */
  const minted = new Set<string>();
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
    expand(call, check) {
      const field = isRecord(call.input) ? NOTE_FIELDS[call.name] : undefined;
      const at = field && isRecord(call.input) ? field(call.input) : null;
      if (!at || !Array.isArray(at.notes) || !at.notes.some(Array.isArray)) {
        const refused = check?.(call) ?? null;
        if (refused !== null) return refusedCall(refused);
        return accept(call, []);
      }
      const events: unknown[] = [];
      const noteIds: string[] = [];
      let next = counter;
      for (const [index, note] of at.notes.entries()) {
        if (!Array.isArray(note)) {
          events.push(note);
          continue;
        }
        const parsed = compactNoteSchema.safeParse(note);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = [at.path, index, ...(issue?.path ?? [])].join(".");
          return refusedCall(
            `${where}: ${issue?.message ?? "not a note"}; a note is [startTicks, pitch or padId, durationTicks, velocity]`,
          );
        }
        const free = nextFree(next);
        if (free === null) {
          return refusedCall(
            `One proposal may write at most ${MAX_TURN_NOTES} notes; loop a short clip instead`,
          );
        }
        next = free.at;
        noteIds.push(free.id);
        events.push(noteEventOf(parsed.data, free.id));
      }
      const expanded = { ...call, input: at.write(events) };
      const refused = check?.(expanded) ?? null;
      if (refused !== null) return refusedCall(refused);
      counter = next;
      return accept(expanded, noteIds, call);
    },
  };

  /**
   * `call` accepted: the note IDs it holds, the gateway's and the model's
   * own (read off the call as the model sent it), are taken from now on.
   */
  function accept(
    call: AssistantToolCall,
    noteIds: readonly string[],
    sent: AssistantToolCall = call,
  ): ExpandedCall {
    for (const id of noteIds) minted.add(id);
    for (const id of [...noteIds, ...modelNoteIds(sent)]) taken.add(id);
    return { ok: true, call, noteIds };
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
export function expandAskPreviews(ask: AssistantAsk, stem: string): AssistantAsk {
  if (!ask.options.some((option) => option.sound?.kind === "preview")) return ask;
  return { ...ask, options: ask.options.map((option) => expandPreview(option, stem)) };
}

function expandPreview(option: AskOption, stem: string): AskOption {
  const sound = option.sound;
  if (sound?.kind !== "preview") return option;
  const notes = createNoteExpander(stem, PREVIEW_NOTE_MARK);
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
