/**
 * Clip reuse (GRV-131, plan step 3), behind the `clipReuse` tactic.
 *
 * Even as GRV-131's compact tuples, a part costs its notes every time it is
 * written, and a sketch or an arrangement writes many parts that are another
 * part again: the same clip in a later section, a sparser intro that is the
 * main loop with hits left out, a fill that is the groove with a few notes
 * added. With the tactic on, the model can say so instead of writing the
 * notes again:
 *
 * - **Place a clip again by bars.** `placement_create` takes
 *   `{ clipId, bars: [first, last] }` (bars counted from 1, both included).
 *   The gateway fills in the rest: a new placement ID, the clip's track (from
 *   the description's placements, or the `clip_create` earlier in the turn
 *   that made it), `clipOffsetTicks` 0 and `looped: true`. `startTicks` and
 *   `durationTicks` still work in place of `bars`, and any field given is
 *   kept. The tools already allowed a placement of any clip, existing or
 *   just made; what this adds is that the placement costs a few tokens.
 * - **Copy a clip as a variation.** `clip_create`'s content may be
 *   `{ kind: "copy", clipId, eventIds?, events? }`: the notes of a clip the
 *   gateway knows (one the turn made, or one whose notes the description
 *   lists), all of them or those `eventIds` names, with new IDs, plus any new
 *   notes in `events` in every form the turn's tactics offer.
 * - **Duplicate notes without making their IDs.** `notes_duplicate` may leave
 *   out `newIds`; the gateway gives the copies IDs from the turn's note
 *   counter, as it gives the notes the model writes.
 *
 * The note expander (`compactNotes.ts`) does the writing out, so every ID
 * comes from the turn's ID stem in the order calls are accepted, and nothing
 * past the gateway ever sees a short placement, a copy or a duplicate with no
 * IDs. This module holds what that needs: the offered schemas, what the
 * gateway knows of each clip ({@link ClipLedger}) and how one call changes
 * it, and the pure rewrites of each form.
 *
 * Pure, and like the rest of `src/assistant`, free of Firebase and any SDK.
 */
import { z } from "zod";
import { notesDuplicatePayloadSchema } from "../commands/definitions/transforms";
import type { NoteEvent } from "../domain/entities";
import {
  clipIdSchema,
  eventIdSchema,
  ID_PREFIXES,
  placementIdSchema,
  trackIdSchema,
} from "../domain/ids";
import { durationTickSchema, TICKS_PER_BAR, tickSchema } from "../domain/time";
import type { AssistantContextPayload } from "./protocol";

/** The digits after a placement mark, so a minted ID keeps a new ID's length. */
const GATEWAY_PLACEMENT_DIGITS = 3;

/** The most placements the gateway mints in one turn. */
export const MAX_TURN_PLACEMENTS = 10 ** GATEWAY_PLACEMENT_DIGITS - 1;

/**
 * The `index`th placement ID the gateway mints in a turn given `stem`, from 1,
 * in the counter `mark` starts. Like a minted note ID, its counter starts with
 * a letter, which the model's own new IDs (digits only) never do.
 */
export function gatewayPlacementId(stem: string, index: number, mark: string): string {
  return `${ID_PREFIXES.placement}_${stem}${mark}${String(index).padStart(GATEWAY_PLACEMENT_DIGITS, "0")}`;
}

/** The pattern of every placement ID the gateway mints in a turn given `stem` and `mark`. */
export function gatewayPlacementPattern(stem: string, mark: string): RegExp {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${ID_PREFIXES.placement}_${escaped}${mark}\\d{${GATEWAY_PLACEMENT_DIGITS}}$`,
  );
}

/** A bar number as a short placement takes it: the song's first bar is 1. */
const barSchema = z.int().min(1);

/** What the tools say a short placement's `bars` is. */
export const PLACEMENT_BARS_DESCRIPTION =
  "The first and last bar the clip plays in, counted from 1, both included: [5, 8] is bars 5 to 8. Takes the place of startTicks and durationTicks.";

/** `placement_create`'s input as the model is offered it with `clipReuse` on. */
export const reusePlacementSchema = z.strictObject({
  id: placementIdSchema.optional(),
  clipId: clipIdSchema,
  trackId: trackIdSchema.optional(),
  bars: z.tuple([barSchema, barSchema]).describe(PLACEMENT_BARS_DESCRIPTION).optional(),
  startTicks: tickSchema.optional(),
  durationTicks: durationTickSchema.optional(),
  clipOffsetTicks: tickSchema.optional(),
  looped: z.boolean().optional(),
});

/** `notes_duplicate`'s input as the model is offered it with `clipReuse` on. */
export const reuseNotesDuplicateSchema = notesDuplicatePayloadSchema.extend({
  newIds: notesDuplicatePayloadSchema.shape.newIds
    .describe(
      "Leave out, and Groove gives the copies their IDs. Given, one new note ID per note copied, in order.",
    )
    .optional(),
});

/**
 * A `clip_create` content that copies another clip's notes, with `entry` the
 * form a new note takes in its `events` (whatever the turn's tactics offer).
 */
export function copyContentSchema(entry: z.ZodType) {
  return z.strictObject({
    kind: z.literal("copy"),
    clipId: clipIdSchema.describe("The clip whose notes are copied."),
    eventIds: z
      .array(eventIdSchema)
      .min(1)
      .describe("The notes to copy, by ID; leave out to copy every note.")
      .optional(),
    events: z
      .array(entry)
      .describe("New notes to add to the copy, as content.events takes them.")
      .optional(),
  });
}

/** What the gateway knows of one clip. */
export interface KnownClip {
  readonly trackId: string;
  /**
   * Its notes the gateway has, as the turn leaves them, or null when it has
   * none it can trust: a clip the description places but whose notes it does
   * not list, or one a call changed in a way the gateway does not follow.
   */
  readonly events: readonly NoteEvent[] | null;
  /**
   * True when `events` is only some of the clip's notes: the selection picked
   * single notes, a bar range or a section, or the note cap cut it short. The
   * notes it has can be copied by ID; the whole clip cannot be copied or
   * duplicated, since the gateway cannot tell what else it holds.
   */
  readonly partial?: boolean;
}

/** Every clip the gateway knows of, by ID. */
export type ClipLedger = ReadonlyMap<string, KnownClip>;

/**
 * The selection kinds that pick a clip's notes all or not at all
 * (`src/projection/selectedNotes.ts`): a clip, a placement and a track pick
 * every note of their clips; a project, a device and an automation point
 * pick none. A note, a bar range and a section pick only some, and a kind
 * not named here is taken to as well.
 */
const WHOLE_CLIP_SELECTION_KINDS = new Set([
  "clip",
  "placement",
  "track",
  "project",
  "device",
  "automationPoint",
]);

/**
 * Whether the selection lists each of its clips with every note: no note
 * left out by the cap, and every scope selected one that picks a clip whole.
 */
function listsWholeClips(context: AssistantContextPayload): boolean {
  const selected = context.selectedNotes;
  if (!selected || selected.omittedNoteCount > 0 || !context.selection) return false;
  return Object.entries(context.selection.countByKind).every(
    ([kind, count]) => count === 0 || WHOLE_CLIP_SELECTION_KINDS.has(kind),
  );
}

/**
 * The clips the project context tells of: each placed clip with its track,
 * and the notes of each clip the selection lists. Those notes are the whole
 * clip only when the selection picked whole clips and the note cap cut
 * nothing; otherwise they are some of its notes ({@link KnownClip.partial}).
 */
export function contextClips(context: AssistantContextPayload): ClipLedger {
  const clips = new Map<string, KnownClip>();
  for (const track of context.tracks) {
    for (const placement of track.placements) {
      clips.set(placement.clipId, { trackId: track.id, events: null });
    }
  }
  const selected = context.selectedNotes;
  if (selected) {
    const whole = listsWholeClips(context);
    for (const clip of selected.clips) {
      clips.set(clip.clipId, {
        trackId: clip.trackId,
        events: clip.events as unknown as readonly NoteEvent[],
        ...(whole ? {} : { partial: true }),
      });
    }
  }
  return clips;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Note events as a written-out call carries them, or null when they are not. */
function noteEventsOf(value: unknown): NoteEvent[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((event) => isRecord(event) && typeof event.id === "string")
    ? (value as NoteEvent[])
    : null;
}

/** The tools that change a clip's notes in a way the ledger does not follow. */
const UNFOLLOWED_NOTE_TOOLS = new Set([
  "note_update",
  "notes_transpose",
  "notes_scaleVelocity",
  "notes_quantize",
  "notes_quantizeToScale",
  "notes_vary",
  "clip_update",
]);

/**
 * `ledger` once `call`, accepted and written out, has joined the proposal: a
 * clip it makes, the notes it adds, removes, clears or duplicates, a clip or
 * track it deletes. A call it cannot read, or one that changes notes in a
 * way the ledger does not follow (a transform, an update, a resize), leaves
 * the clip's notes unknown.
 */
export function withClipCall(
  ledger: ClipLedger,
  call: {
    readonly name: string;
    readonly input: unknown;
  },
): ClipLedger {
  const input = call.input;
  if (!isRecord(input)) return ledger;
  const clipId = stringOf(input.clipId);
  const known = clipId === null ? undefined : ledger.get(clipId);
  const withEvents = (
    events: readonly NoteEvent[] | null,
    partial = known?.partial === true,
  ): ClipLedger =>
    clipId === null || !known
      ? ledger
      : new Map(ledger).set(clipId, {
          trackId: known.trackId,
          events,
          ...(partial && events ? { partial: true } : {}),
        });
  switch (call.name) {
    case "clip_create": {
      const id = stringOf(input.id);
      const trackId = stringOf(input.trackId);
      if (id === null || trackId === null) return ledger;
      const content = isRecord(input.content) ? input.content : null;
      const events = content?.kind === "notes" ? noteEventsOf(content.events) : null;
      return new Map(ledger).set(id, { trackId, events });
    }
    case "clip_delete": {
      if (clipId === null || !known) return ledger;
      const next = new Map(ledger);
      next.delete(clipId);
      return next;
    }
    case "track_delete": {
      const trackId = stringOf(input.trackId);
      return new Map([...ledger].filter(([, clip]) => clip.trackId !== trackId));
    }
    case "note_add": {
      const added = noteEventsOf(input.notes);
      return withEvents(known?.events && added ? [...known.events, ...added] : null);
    }
    case "note_remove": {
      const removed = Array.isArray(input.eventIds) ? new Set(input.eventIds) : null;
      return withEvents(
        known?.events && removed
          ? known.events.filter((event) => !removed.has(event.id))
          : null,
      );
    }
    case "notes_clear":
      return withEvents([], false);
    case "notes_duplicate":
      return withEvents(duplicated(known ?? null, input));
    default:
      return UNFOLLOWED_NOTE_TOOLS.has(call.name) ? withEvents(null) : ledger;
  }
}

/** `events` with a `notes_duplicate`'s copies added, as the command adds them. */
function duplicated(
  known: KnownClip | null,
  input: Record<string, unknown>,
): NoteEvent[] | null {
  const events = known?.events;
  const offset = input.offsetTicks;
  const newIds = input.newIds;
  if (!events || typeof offset !== "number" || !Array.isArray(newIds)) return null;
  // Every note of a clip the gateway has only some of copies notes it has not seen.
  if (known.partial && !Array.isArray(input.eventIds)) return null;
  const selected = selectedEvents(events, input.eventIds);
  if (typeof selected === "string" || selected.length !== newIds.length) {
    return null;
  }
  const copies = selected.map((event, index) => ({
    ...event,
    id: String(newIds[index]) as NoteEvent["id"],
    startTicks: (event.startTicks + offset) as NoteEvent["startTicks"],
  }));
  return [...events, ...copies];
}

/**
 * The events `eventIds` names in `events`, in the clip's order, or why not:
 * `null` or `undefined` names them all.
 */
function selectedEvents(
  events: readonly NoteEvent[],
  eventIds: unknown,
  partial = false,
): readonly NoteEvent[] | string {
  if (eventIds === null || eventIds === undefined) return events;
  if (!Array.isArray(eventIds)) return "eventIds is a list of note IDs";
  const known = new Set<string>(events.map((event) => event.id));
  const missing = eventIds.filter((id) => typeof id !== "string" || !known.has(id));
  if (missing.length > 0) {
    return `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}: ${partial ? "not a note the description lists in that clip" : "not a note of that clip"}`;
  }
  const named = new Set(eventIds);
  return events.filter((event) => named.has(event.id));
}

/** Why a clip's notes cannot be copied or counted. */
function unknownNotes(clipId: string, ledger: ClipLedger): string {
  const known = ledger.get(clipId);
  if (!known) {
    return `${clipId} is not a clip made earlier in this proposal or one whose notes the description lists`;
  }
  return known.events && known.partial
    ? `Groove has only the notes of ${clipId} the selection lists, not every note of it: name the notes with eventIds, or write them out`
    : `Groove does not have every note of ${clipId}: only a clip made earlier in this proposal, or one whose notes the description lists, can be copied whole. Name the notes to copy with eventIds, or write them out`;
}

/** One note event as a compact note, which the expander writes out again with a new ID. */
function asCompactNote(event: NoteEvent): unknown[] {
  const sound =
    event.trigger.kind === "pitch" ? event.trigger.pitch : event.trigger.padId;
  const note: unknown[] = [event.startTicks, sound, event.durationTicks, event.velocity];
  if (event.probability !== null) note.push(event.probability);
  return note;
}

/** A rewrite of one call's input, or why the call is refused. */
export type Rewrite =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * A `clip_create` whose content is a copy, as a `clip_create` of notes: the
 * copied notes as compact notes (in the source clip's order), then the new
 * ones, for the note expander to write out with new IDs. Any other input
 * comes back as it is.
 */
export function rewriteClipCopy(
  input: Record<string, unknown>,
  ledger: ClipLedger,
): Rewrite {
  const content = input.content;
  if (!isRecord(content) || content.kind !== "copy") return { ok: true, input };
  const parsed = copyContentSchema(z.unknown()).safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `content.${issue?.path.join(".") ?? ""}: ${issue?.message ?? "not a copy"}; a copy is {kind: "copy", clipId, eventIds, events}`,
    };
  }
  const { clipId, eventIds, events = [] } = parsed.data;
  const source = ledger.get(clipId);
  if (!source?.events || (source.partial && eventIds === undefined)) {
    return { ok: false, reason: `content.clipId: ${unknownNotes(clipId, ledger)}` };
  }
  const selected = selectedEvents(source.events, eventIds, source.partial);
  if (typeof selected === "string") {
    return { ok: false, reason: `content.eventIds: ${selected}` };
  }
  return {
    ok: true,
    input: {
      ...input,
      content: { kind: "notes", events: [...selected.map(asCompactNote), ...events] },
    },
  };
}

/**
 * How many new IDs a `notes_duplicate` with no `newIds` needs: one per note
 * it copies. Every note named by `eventIds` needs no knowledge of the clip;
 * `eventIds: null` (every note) needs the clip's notes known.
 */
export function duplicateCount(
  input: Record<string, unknown>,
  ledger: ClipLedger,
): number | string {
  if (Array.isArray(input.eventIds)) return input.eventIds.length;
  const clipId = stringOf(input.clipId);
  if (clipId === null) return "clipId: the clip whose notes are duplicated";
  const known = ledger.get(clipId);
  if (!known?.events || known.partial) return `clipId: ${unknownNotes(clipId, ledger)}`;
  return known.events.length;
}

/**
 * A short `placement_create` written out as a whole placement, with `id` the
 * ID to give it when it names none, or why it cannot be. A whole placement
 * comes back as it is.
 */
export function rewritePlacement(
  input: Record<string, unknown>,
  ledger: ClipLedger,
  id: string,
): Rewrite {
  const parsed = reusePlacementSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `${issue?.path.join(".") || "(input)"}: ${issue?.message ?? "not a placement"}`,
    };
  }
  const { bars, startTicks, durationTicks, ...rest } = parsed.data;
  let span: { startTicks: number; durationTicks: number };
  if (bars) {
    if (startTicks !== undefined || durationTicks !== undefined) {
      return {
        ok: false,
        reason: "bars: give bars, or startTicks and durationTicks, not both",
      };
    }
    const [first, last] = bars;
    // Bars are 4/4 (TICKS_PER_BAR): the alpha's time signature is fixed at
    // 4/4 (src/domain/time.ts), so a bar is four quarter notes.
    if (last < first) {
      return {
        ok: false,
        reason: `bars: the last bar, ${last}, is before the first, ${first}`,
      };
    }
    span = {
      startTicks: (first - 1) * TICKS_PER_BAR,
      durationTicks: (last - first + 1) * TICKS_PER_BAR,
    };
  } else if (startTicks !== undefined && durationTicks !== undefined) {
    span = { startTicks, durationTicks };
  } else {
    return {
      ok: false,
      reason:
        "bars: say where the clip plays, as bars [first, last] or as startTicks and durationTicks",
    };
  }
  const trackId = rest.trackId ?? ledger.get(rest.clipId)?.trackId;
  if (trackId === undefined) {
    return {
      ok: false,
      reason: `trackId: ${rest.clipId} is not placed in the description or made earlier in this proposal, so give its track`,
    };
  }
  return {
    ok: true,
    input: {
      id: rest.id ?? id,
      clipId: rest.clipId,
      trackId,
      ...span,
      clipOffsetTicks: rest.clipOffsetTicks ?? 0,
      looped: rest.looped ?? true,
    },
  };
}
