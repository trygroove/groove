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
 * the calls came ({@link gatewayNoteId}: a counter the model's own IDs never
 * use, so the two cannot collide), so the proposal the browser validates, previews, applies,
 * undoes and keeps in a transcript is made of ordinary note events and
 * ordinary command payloads, exactly as before. Nothing outside the gateway
 * ever sees a compact note.
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
  .describe(COMPACT_NOTE_DESCRIPTION);
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
 * so a counter that starts with a letter is one it never makes.
 */
const GATEWAY_NOTE_MARK = "n";

/** The digits after {@link GATEWAY_NOTE_MARK}, so the ID keeps its length. */
const GATEWAY_NOTE_DIGITS = NEW_ID_COUNTER_DIGITS - GATEWAY_NOTE_MARK.length;

/** The most notes one turn may write: what the gateway's counter can number. */
export const MAX_TURN_NOTES = 10 ** GATEWAY_NOTE_DIGITS - 1;

/** The `index`th note ID the gateway mints in a turn given `stem`, from 1. */
export function gatewayNoteId(stem: string, index: number): string {
  return `${ID_PREFIXES.event}_${stem}${GATEWAY_NOTE_MARK}${String(index).padStart(GATEWAY_NOTE_DIGITS, "0")}`;
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
}

/**
 * The expander for one turn: note IDs come from `stem` as every other new ID
 * the turn makes does, in a counter of their own ({@link gatewayNoteId}),
 * counted up across the turn in the order the calls are accepted, so the same
 * calls always expand to the same notes.
 */
export function createNoteExpander(stem: string): NoteExpander {
  let minted = 0;
  return {
    expand(call, check) {
      const field = isRecord(call.input) ? NOTE_FIELDS[call.name] : undefined;
      const at = field && isRecord(call.input) ? field(call.input) : null;
      if (!at || !Array.isArray(at.notes) || !at.notes.some(Array.isArray)) {
        const refused = check?.(call) ?? null;
        return refused === null ? { ok: true, call, noteIds: [] } : refusedCall(refused);
      }
      const events: unknown[] = [];
      const noteIds: string[] = [];
      for (const [index, note] of at.notes.entries()) {
        if (!Array.isArray(note)) {
          events.push(note);
          continue;
        }
        const parsed = compactNoteSchema.safeParse(note);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = [at.path, index, ...(issue?.path ?? [])].join(".");
          return {
            ok: false,
            message: `${where}: ${issue?.message ?? "not a note"}; a note is [startTicks, pitch or padId, durationTicks, velocity]`,
          };
        }
        if (minted + noteIds.length >= MAX_TURN_NOTES) {
          return refusedCall(
            `One proposal may write at most ${MAX_TURN_NOTES} notes; loop a short clip instead`,
          );
        }
        const id = gatewayNoteId(stem, minted + noteIds.length + 1);
        noteIds.push(id);
        events.push(noteEventOf(parsed.data, id));
      }
      const expanded = { ...call, input: at.write(events) };
      const refused = check?.(expanded) ?? null;
      if (refused !== null) return refusedCall(refused);
      minted += noteIds.length;
      return { ok: true, call: expanded, noteIds };
    },
  };
}

function refusedCall(message: string): ExpandedCall {
  return { ok: false, message };
}
