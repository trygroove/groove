/**
 * Four takes of a part to pick from (GRV-207): `offer_takes`, the way an
 * image generator lays out a grid of candidates.
 *
 * When the producer asks for a melodic or harmonic part (a melody, a
 * bassline, a lead, chords) or a drum pattern (GRV-213), the model writes
 * four deliberately different takes of it in one call instead of one
 * proposal, each take the change calls that would write it. What the takes
 * are a part of ({@link takesPartType}) is read off the notes they write: hits
 * on a drum machine's pads make a drum pattern, which the panel hears looped
 * on its pattern's length, and an offer that mixes the two is refused. Like `ask_producer` (`ask.ts`) it changes nothing by
 * itself, so it is never a change call: the gateway writes out each take's
 * compact notes ({@link expandTakesCall}) and refuses the whole call back to
 * the model when a take does not fit its tools, and the call comes back among
 * the proposal's for the browser to take out ({@link splitTakes}). The panel
 * shows one card holding the four; the producer hears each in the song and
 * picks one, which becomes a proposal of its own through the usual path
 * ({@link takeProposal}), or none, or asks for four more.
 *
 * Each take's notes are numbered in a counter of their own
 * ({@link TAKE_NOTE_MARK}), counted from 1 for every take: only one take is
 * ever applied, so its IDs need only be unique within it and apart from the
 * notes the rest of the turn writes.
 *
 * The provider is stateless, so what became of the takes travels in the
 * conversation's text ({@link takesNote}), as an ask's question does.
 *
 * Like the rest of `src/assistant`, Firebase-free and SDK-free.
 */
import { z } from "zod";
import {
  createNoteExpander,
  type ExpandedCheck,
  type StepStringOptions,
} from "./compactNotes";
import type {
  AssistantContextPayload,
  AssistantProposal,
  AssistantToolCall,
  TakePartType,
} from "./protocol";
import { ASSISTANT_TOOLSET_VERSION, resolveToolCall } from "./tools";

/** The tool's name, as the model calls it. */
export const OFFER_TAKES_TOOL_NAME = "offer_takes";

/** How many takes one call offers: always four. */
export const TAKE_COUNT = 4;

/** How much one offer may say. */
export const TAKES_LIMITS = {
  partChars: 60,
  labelChars: 60,
  /** The most changes one take may carry. */
  callsPerTake: 12,
} as const;

/**
 * What starts the counter of a note ID the gateway mints in a take: one of
 * its own, so a take's notes never share an ID with a note the rest of the
 * turn's proposal writes (`compactNotes.ts`'s `n`) or an ask's preview (`p`).
 */
export const TAKE_NOTE_MARK = "t";

const text = (max: number) => z.string().trim().min(1).max(max);

/** One change in a take, exactly as a change tool is called. */
const takeCallSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("One of your change tools, such as clip_create or note_add."),
  input: z.record(z.string(), z.unknown()).describe("Its input, as you would call it."),
});

const takeSchema = z.strictObject({
  label: text(TAKES_LIMITS.labelChars).describe(
    'A few words on how this take differs from the others ("Sparse, low, lots of rests", "Half-time, kick on 1 only").',
  ),
  calls: z
    .array(takeCallSchema)
    .min(1)
    .max(TAKES_LIMITS.callsPerTake)
    .describe(
      "Every change that writes this take, in order, as a proposal of its own: its track if the part needs a new one, its clip with its notes (a drum pattern's hits on its drum machine's pads), and its placement.",
    ),
});

/** What the model sends: the tool's input. */
export const offerTakesInputSchema = z.strictObject({
  part: text(TAKES_LIMITS.partChars).describe(
    'The part the takes are of, as the producer would name it ("Lead melody", "Bassline", "Chords", "Drum pattern").',
  ),
  takes: z
    .array(takeSchema)
    .length(TAKE_COUNT)
    .describe(`Exactly ${TAKE_COUNT} takes of the part, each clearly different.`),
});
export type OfferTakesInput = z.infer<typeof offerTakesInputSchema>;

/** One take, as the browser shows it. */
export interface AssistantTake {
  readonly label: string;
  readonly calls: readonly AssistantToolCall[];
}

/** The four takes one call offers, as the browser receives them. */
export interface AssistantTakes {
  /** The tool call's ID, unique within the conversation. */
  readonly id: string;
  readonly part: string;
  /** A melodic or harmonic part, or a drum pattern (GRV-213), read off the notes. */
  readonly partType: TakePartType;
  readonly takes: readonly AssistantTake[];
}

const TOOL_DESCRIPTION = `Offer the producer ${TAKE_COUNT} takes of one new part to pick from, instead of proposing one: a melodic or harmonic part (a melody, a bassline, a lead, chords) or a drum pattern. Each take is the change calls that would write it, as a proposal of its own, and all ${TAKE_COUNT} are of the same part: pitched notes, or a drum pattern's hits on a drum machine's pads, never some of each. Make the takes clearly different from one another: a melodic part along rhythm density, register, contour and use of rests, each in key and fitting the song; a drum pattern along density, groove feel (straight or swung, where the hits sit and how hard), kick placement, hat and percussion variation, and fills. The producer hears each take in the song (a drum pattern looped on its own length) and picks one, which is then applied; nothing changes until they do. Make it your last call: say one line before it, nothing after, and call no other change tool or explain_change in the same turn.`;

/** The tool as the model is offered it. */
export interface TakesToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

let toolCache: TakesToolDefinition | null = null;

/** `offer_takes`, its input schema generated from {@link offerTakesInputSchema}. */
export function offerTakesTool(): TakesToolDefinition {
  if (!toolCache) {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(offerTakesInputSchema, {
      io: "input",
    }) as Record<string, unknown>;
    toolCache = {
      name: OFFER_TAKES_TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema,
    };
  }
  return toolCache;
}

/** Whether a tool call offers takes rather than proposing a change. */
export function isTakesCall(call: Pick<AssistantToolCall, "name">): boolean {
  return call.name === OFFER_TAKES_TOOL_NAME;
}

/** A take's calls as tool calls of their own, each with an ID made from the offer's. */
function takeCalls(
  offerId: string,
  takeIndex: number,
  calls: OfferTakesInput["takes"][number]["calls"],
): AssistantToolCall[] {
  return calls.map((call, index) => ({
    id: `${offerId}:${takeIndex + 1}:${index + 1}`,
    name: call.name,
    input: call.input,
  }));
}

/** Every take's labels must differ, or the producer cannot tell them apart. */
function repeatedLabel(input: OfferTakesInput): string | null {
  const seen = new Set<string>();
  for (const take of input.takes) {
    const label = take.label.toLowerCase();
    if (seen.has(label)) return take.label;
    seen.add(label);
  }
  return null;
}

/** A written-out note as it sounds, or null when `value` is not one. */
function soundingNote(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const note = value as Record<string, unknown>;
  const trigger = note.trigger as Record<string, unknown> | undefined;
  if (typeof trigger !== "object" || trigger === null) return null;
  return JSON.stringify([
    trigger.pitch ?? trigger.padId,
    note.startTicks,
    note.durationTicks,
  ]);
}

/** The notes a call writes once written out: a new clip's, or the ones `note_add` adds. */
function writtenNotes(call: {
  readonly name: string;
  readonly input: unknown;
}): unknown[] {
  const input = call.input as Record<string, unknown> | null;
  if (typeof input !== "object" || input === null) return [];
  if (call.name === "clip_create") {
    const content = input.content as Record<string, unknown> | undefined;
    return content?.kind === "notes" && Array.isArray(content.events)
      ? content.events
      : [];
  }
  if (call.name === "note_add") return Array.isArray(input.notes) ? input.notes : [];
  return [];
}

/**
 * A take's notes as they sound, once written out: pitch (or pad), start and
 * length of every note its calls write, in order, without the IDs and
 * velocities that make two takes look different when they play the same.
 * Null when the take writes no notes, so there is nothing to compare.
 */
export function takeNoteContent(
  calls: readonly { readonly name: string; readonly input: unknown }[],
): string | null {
  const notes = calls
    .flatMap(writtenNotes)
    .map(soundingNote)
    .filter((note): note is string => note !== null)
    .sort();
  return notes.length > 0 ? JSON.stringify(notes) : null;
}

/** What one written-out note is: a pitched note, a drum hit, or neither. */
function noteKind(value: unknown): "pitch" | "pad" | null {
  if (typeof value !== "object" || value === null) return null;
  const trigger = (value as Record<string, unknown>).trigger as
    | Record<string, unknown>
    | undefined;
  if (typeof trigger !== "object" || trigger === null) return null;
  if (trigger.kind === "pad" || trigger.padId !== undefined) return "pad";
  if (trigger.kind === "pitch" || trigger.pitch !== undefined) return "pitch";
  return null;
}

/** The kinds of note an offer's takes write, once written out. */
function noteKinds(
  takes: readonly {
    readonly calls: readonly { readonly name: string; readonly input: unknown }[];
  }[],
): ReadonlySet<"pitch" | "pad"> {
  const kinds = new Set<"pitch" | "pad">();
  for (const take of takes) {
    for (const note of take.calls.flatMap(writtenNotes)) {
      const kind = noteKind(note);
      if (kind) kinds.add(kind);
    }
  }
  return kinds;
}

/**
 * What an offer's takes are a part of (GRV-213), read off the notes they
 * write once written out: a drum pattern when every note is a hit on a pad,
 * otherwise a melodic or harmonic part.
 */
export function takesPartType(
  takes: readonly {
    readonly calls: readonly { readonly name: string; readonly input: unknown }[];
  }[],
): TakePartType {
  const kinds = noteKinds(takes);
  return kinds.has("pad") && !kinds.has("pitch") ? "drums" : "melodic";
}

/**
 * The first two takes (by number, from 1) whose notes are the same, or null
 * when every take that writes notes writes different ones.
 */
export function takesWithSameNotes(
  takes: readonly {
    readonly calls: readonly { readonly name: string; readonly input: unknown }[];
  }[],
): readonly [number, number] | null {
  const seen = new Map<string, number>();
  for (const [index, take] of takes.entries()) {
    const content = takeNoteContent(take.calls);
    if (content === null) continue;
    const earlier = seen.get(content);
    if (earlier !== undefined) return [earlier + 1, index + 1];
    seen.set(content, index);
  }
  return null;
}

/** What {@link expandTakesCall} makes of an offer. */
export type ExpandedTakes =
  | { readonly ok: true; readonly call: AssistantToolCall }
  | { readonly ok: false; readonly message: string };

/** Judges one of a take's calls once written out: its tool's own schema. */
const fitsItsTool: ExpandedCheck = (written) => {
  const resolution = resolveToolCall(written.name, written.input);
  return resolution.ok ? null : resolution.message;
};

/** The tools that make an entity, which a take's new track, clip and placement come from. */
const CREATE_TOOLS = new Set(["track_create", "clip_create", "placement_create"]);

/**
 * Every track, clip and placement ID the song already has, as a turn's
 * context lists them, for {@link expandTakesCall} to keep a take from making
 * one again.
 */
export function contextEntityIds(
  context: Pick<AssistantContextPayload, "tracks">,
): ReadonlySet<string> {
  return new Set(
    context.tracks.flatMap((track) => [
      track.id,
      ...track.placements.flatMap((placement) => [placement.id, placement.clipId]),
    ]),
  );
}

/**
 * Why a take's written-out call cannot apply to the song: it makes a track,
 * clip or placement under an ID the song already has. The browser would
 * refuse the take, and the producer would see a card of takes none of which
 * can be used (GRV-207), so the model is told instead and can make new IDs.
 */
function remadeId(
  call: { readonly name: string; readonly input: Record<string, unknown> },
  inSong: ReadonlySet<string>,
): string | null {
  if (!CREATE_TOOLS.has(call.name)) return null;
  const id = call.input.id;
  if (typeof id !== "string" || !inSong.has(id)) return null;
  return `${id} is already in the song; make every new ID from this turn's stem, never reuse one`;
}

/**
 * The offer with every take's compact notes written out, each take in a
 * counter of its own ({@link TAKE_NOTE_MARK}) from `stem`, or why it cannot
 * be shown: not an offer of four takes, two takes under one label, a take
 * with a call that does not fit its tool or that makes an entity under an ID
 * in `inSong` (named by take and call, counting from 1), takes that mix drum
 * hits with pitched notes, or two takes that
 * play the same notes. Never throws.
 */
export function expandTakesCall(
  call: AssistantToolCall,
  stem: string,
  stepStrings?: StepStringOptions,
  inSong: ReadonlySet<string> = new Set(),
): ExpandedTakes {
  const parsed = offerTakesInputSchema.safeParse(call.input);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      message: `offer_takes needs a part and ${TAKE_COUNT} takes (${where})`,
    };
  }
  const repeated = repeatedLabel(parsed.data);
  if (repeated !== null) {
    return {
      ok: false,
      message: `two takes are both labelled "${repeated}"; give each its own`,
    };
  }
  const takes: OfferTakesInput["takes"] = [];
  for (const [takeIndex, take] of parsed.data.takes.entries()) {
    const notes = createNoteExpander(stem, TAKE_NOTE_MARK, stepStrings);
    const asCalls = takeCalls(call.id, takeIndex, take.calls);
    notes.reserve(asCalls);
    const written: OfferTakesInput["takes"][number]["calls"] = [];
    for (const [callIndex, inner] of asCalls.entries()) {
      const refused = (why: string): ExpandedTakes => ({
        ok: false,
        message: `take ${takeIndex + 1}, call ${callIndex + 1} (${inner.name}): ${why}`,
      });
      const expanded = notes.expand(inner, fitsItsTool);
      if (!expanded.ok) return refused(expanded.message);
      const writtenCall = {
        name: expanded.call.name,
        input: expanded.call.input as Record<string, unknown>,
      };
      const remade = remadeId(writtenCall, inSong);
      if (remade !== null) return refused(remade);
      written.push(writtenCall);
    }
    takes.push({ label: take.label, calls: written });
  }
  const kinds = noteKinds(takes);
  if (kinds.has("pad") && kinds.has("pitch")) {
    return {
      ok: false,
      message:
        "the takes mix drum hits on pads with pitched notes; offer takes of one part, either a drum pattern or a melodic part, and the other part as a proposal of its own",
    };
  }
  const same = takesWithSameNotes(takes);
  if (same !== null) {
    return {
      ok: false,
      message: `takes ${same[0]} and ${same[1]} play the same notes; make each take clearly different`,
    };
  }
  return {
    ok: true,
    call: { ...call, input: { part: parsed.data.part, takes } satisfies OfferTakesInput },
  };
}

/**
 * The call as the four takes the browser shows, or null when its input is
 * not an offer of four, or the gateway could not write it out (its
 * `refusal`). The calls are not checked against the song here: the browser
 * validates each take as a proposal against the project.
 */
export function parseTakesCall(call: AssistantToolCall): AssistantTakes | null {
  if (!isTakesCall(call) || call.refusal !== undefined) return null;
  const parsed = offerTakesInputSchema.safeParse(call.input);
  if (!parsed.success || repeatedLabel(parsed.data) !== null) return null;
  return {
    id: call.id,
    part: parsed.data.part,
    partType: takesPartType(parsed.data.takes),
    takes: parsed.data.takes.map((take, index) => ({
      label: take.label,
      calls: takeCalls(call.id, index, take.calls),
    })),
  };
}

/** Take `index` (from 0) as a proposal of its own, against `baseRevision`. */
export function takeProposal(
  takes: AssistantTakes,
  index: number,
  baseRevision: number,
): AssistantProposal {
  return {
    baseRevision,
    toolsetVersion: ASSISTANT_TOOLSET_VERSION,
    calls: takes.takes[index]?.calls ?? [],
  };
}

/** A proposal with its offers of takes taken out. */
export interface SplitTakes {
  /** The rest of the proposal, or null when it was only offers. */
  readonly proposal: AssistantProposal | null;
  readonly offers: readonly AssistantToolCall[];
}

/** Takes a turn's offers of takes out of its proposal. */
export function splitTakes(proposal: AssistantProposal): SplitTakes {
  const offers = proposal.calls.filter(isTakesCall);
  if (offers.length === 0) return { proposal, offers };
  const rest = proposal.calls.filter((call) => !isTakesCall(call));
  return { proposal: rest.length > 0 ? { ...proposal, calls: rest } : null, offers };
}

/**
 * The proposal with each offer of takes replaced by its first take's calls:
 * what a producer who always picks take 1 applies. The evals judge a turn
 * that offered takes this way (`evals/run.ts`, `evals/session.ts`), so a
 * melodic part is judged as the change it would make. An offer that does not
 * parse is left in place, for validation to refuse.
 */
export function withFirstTake(proposal: AssistantProposal): AssistantProposal {
  if (!proposal.calls.some(isTakesCall)) return proposal;
  return {
    ...proposal,
    calls: proposal.calls.flatMap((call) => {
      if (!isTakesCall(call)) return [call];
      const takes = parseTakesCall(call);
      return takes?.takes[0] ? [...takes.takes[0].calls] : [call];
    }),
  };
}

/**
 * What became of an offer, as the conversation resends it after the reply:
 * still waiting (or lost to a reload), one picked (by its number, from 1),
 * none of them, or four more asked for.
 */
export type TakesOutcome = "pending" | "picked" | "none" | "more";

export const TAKES_OUTCOMES = [
  "pending",
  "picked",
  "none",
  "more",
] as const satisfies readonly TakesOutcome[];

/** An offer of takes as a reply carries it, for the next turn's history. */
export interface HistoryTakes {
  readonly part: string;
  readonly labels: readonly string[];
  readonly outcome: TakesOutcome;
  /** For `picked`: the take's number, from 1. */
  readonly picked?: number;
}

/** The offer as a reply first carries it, before the producer decides. */
export function historyTakes(takes: AssistantTakes): HistoryTakes {
  return {
    part: takes.part,
    labels: takes.takes.map((take) => take.label),
    outcome: "pending",
  };
}

/**
 * The line the model reads after a reply that offered takes: what they were
 * and what the producer did with them. A picked take is a proposal of its
 * own, whose own line follows this one (`history.ts`). It says the call did
 * it and that the line is not the model's to write: read back without that,
 * a model wrote the line into its reply in place of the call (GRV-207).
 */
export function takesNote(takes: HistoryTakes): string {
  const listed = takes.labels.map((label, index) => `${index + 1}. ${label}`).join("; ");
  const offered = `[I offered the producer ${takes.labels.length} takes of the ${takes.part} by calling ${OFFER_TAKES_TOOL_NAME}: ${listed}. Only the call showed them; this line is Groove's, never mine to write.`;
  switch (takes.outcome) {
    case "picked":
      return `${offered} They picked take ${takes.picked ?? "?"}, which became a proposal.]`;
    case "none":
      return `${offered} They turned all of them down. Nothing in them is in the song.]`;
    case "more":
      return `${offered} They asked for ${TAKE_COUNT} more instead. Nothing in them is in the song.]`;
    case "pending":
      return `${offered} They have not picked one. Nothing in them is in the song.]`;
  }
}

/**
 * What "4 more" adds to the producer's request, so the next turn offers a
 * fresh set rather than the same four again.
 */
export function moreTakesNote(takes: Pick<HistoryTakes, "part" | "labels">): string {
  const listed = takes.labels.map((label, index) => `${index + 1}. ${label}`).join("; ");
  return `[${TAKE_COUNT} more] None of your last ${takes.labels.length} takes of the ${takes.part} is the one (${listed}). Offer ${TAKE_COUNT} new takes of the same part with ${OFFER_TAKES_TOOL_NAME}, each different from those and from one another.`;
}
