/**
 * The assistant's conversation, kept across a reload (GRV-42): what was said
 * and the question still waiting for an answer, so reloading the editor does
 * not lose either. The gateway keeps nothing a browser can read back (its
 * transcripts are opt-in and denied to every client), and every turn resends
 * the conversation from here anyway (`historyOf`), so the browser's copy is
 * all a restored conversation needs to carry on.
 *
 * Kept in this tab's `sessionStorage`, one entry per account and project, so
 * it survives a reload but not the tab, and one account or project never
 * reads another's. Messages and finished replies are kept (a reply cut off by
 * the reload is kept as stopped), and so are the proposal and sound cards the
 * producer has not decided yet (GRV-135), with the turn that asked for them,
 * so a proposal comes back to be refreshed and a held sound card comes back
 * to be tried. A decided card, an error, a memory card and a video are not
 * kept. A reply keeps what became of its proposal (GRV-150), which the next
 * turn resends. Whatever cannot be read back, a corrupt entry or one written by an
 * older shape, is dropped, never repaired.
 */
import { z } from "zod";
import { type AssistantAsk, assistantAskSchema } from "../../assistant/ask";
import { HISTORY_PROPOSALS } from "../../assistant/history";
import {
  type AssistantLibraryContext,
  type AssistantProposal,
  type AssistantToolCall,
  assistantLibraryContextSchema,
} from "../../assistant/protocol";
import { validateRecommendation } from "../../assistant/recommendation";
import { REPLY_RATINGS, sessionIdSchema } from "../../assistant/transcripts";
import type { Project } from "../../domain/entities";
import { eventIdSchema, placementIdSchema } from "../../domain/ids";
import { LESSON_CHOICES } from "../../lessons/ids";
import type { AssistantScope } from "./assistantScope";
import type { ConversationEntry, TurnOrigin } from "./useAssistantConversation";

/** The prefix of every stored conversation's key. */
export const CONVERSATION_STORAGE_PREFIX = "sg_assistant_conversation_v1";

/** How many messages and replies a stored conversation keeps, the latest. */
export const STORED_ENTRY_LIMIT = 120;

/** The key one account's conversation about one project is kept under. */
export function conversationStorageKey(uid: string, projectId: string): string {
  return `${CONVERSATION_STORAGE_PREFIX}:${uid}:${projectId}`;
}

const entryId = z.string().min(1).max(64);

const storedEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    id: entryId,
    text: z.string(),
    scopeLabel: z.string(),
    answers: z.string().optional(),
    wire: z.string().optional(),
    lesson: z.string().optional(),
    /** The assistant's follow-up after an Apply (GRV-195), which the log hides. */
    automatic: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("reply"),
    id: entryId,
    text: z.string(),
    stopped: z.boolean(),
    failed: z.boolean().optional(),
    ask: assistantAskSchema.optional(),
    turnId: sessionIdSchema.optional(),
    rating: z.enum(REPLY_RATINGS).optional(),
    proposal: z.enum(HISTORY_PROPOSALS).optional(),
    lesson: z.enum(LESSON_CHOICES).optional(),
  }),
]);

/**
 * The scope a card's turn was sent with (GRV-135). The track goes by ID and
 * is looked up again in the song when the conversation is restored.
 */
const storedScopeSchema = z.object({
  level: z.enum(["selection", "track", "song"]),
  catalogScope: z.enum(["clip", "section", "track", "song"]),
  label: z.string(),
  selection: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("notes"), eventIds: z.array(eventIdSchema) }),
      z.object({ kind: z.literal("clips"), placementIds: z.array(placementIdSchema) }),
    ])
    .nullable(),
  trackId: z.string().nullable(),
});

/** The turn a kept card came from, which its Refresh asks again (GRV-135). */
const storedOriginSchema = z.object({
  text: z.string(),
  answers: z.string().optional(),
  wire: z.string().optional(),
  automatic: z.literal(true).optional(),
  turnId: sessionIdSchema.optional(),
  scope: storedScopeSchema,
});

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  refusal: z.string().optional(),
});

/** Which of the stored origins a card's turn is: cards of one turn share one. */
const originIndex = z.number().int().min(0);

const storedCardSchemas = [
  z.object({
    kind: z.literal("proposal"),
    id: entryId,
    proposal: z.object({
      baseRevision: z.number().int(),
      toolsetVersion: z.number().int(),
      calls: z.array(toolCallSchema),
    }),
    origin: originIndex,
    /** The reply that made it, which carries its outcome (GRV-150). */
    replyId: entryId,
  }),
  z.object({
    kind: z.literal("recommendation"),
    id: entryId,
    call: toolCallSchema,
    library: assistantLibraryContextSchema.nullable(),
    origin: originIndex,
  }),
] as const;

const storedSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z.discriminatedUnion("kind", [...storedEntrySchema.options, ...storedCardSchemas]),
    ),
    /** The turns the kept cards came from (GRV-135). */
    origins: z.array(storedOriginSchema).default([]),
    /** The reply whose question is still waiting, or null. */
    pendingAskReplyId: entryId.nullable(),
  })
  .refine((stored) =>
    stored.entries.every(
      (entry) =>
        (entry.kind !== "proposal" && entry.kind !== "recommendation") ||
        entry.origin < stored.origins.length,
    ),
  );

type StoredEntry = Extract<ConversationEntry, { kind: "message" | "reply" }>;

/** A kept card's turn, as it is read back: its scope's track by ID. */
export type StoredOrigin = z.infer<typeof storedOriginSchema>;

/** A proposal or sound card, as it is read back. */
export type StoredCard =
  | {
      readonly kind: "proposal";
      readonly id: string;
      readonly proposal: AssistantProposal;
      readonly origin: StoredOrigin;
      readonly replyId: string;
    }
  | {
      readonly kind: "recommendation";
      readonly id: string;
      readonly call: AssistantToolCall;
      readonly library: AssistantLibraryContext | null;
      readonly origin: StoredOrigin;
    };

/** A conversation as it is kept and read back. */
export interface StoredConversation {
  /** In order. Cards of one turn share one origin object. */
  readonly entries: readonly (StoredEntry | StoredCard)[];
  /** The question still waiting, and the reply that asked it. */
  readonly pendingAsk: { readonly ask: AssistantAsk; readonly replyId: string } | null;
}

type CardEntry = Extract<ConversationEntry, { kind: "proposal" | "recommendation" }>;

/**
 * What is kept of `entries`: messages and replies, a streaming one as
 * stopped, and the cards not yet decided.
 */
function keepable(
  entries: readonly ConversationEntry[],
  decided: (entryId: string) => boolean,
): (StoredEntry | CardEntry)[] {
  const kept: (StoredEntry | CardEntry)[] = [];
  for (const entry of entries) {
    if (entry.kind === "message") kept.push(entry);
    else if (entry.kind === "reply") {
      // A reply the reload cut off is one that was stopped, or nothing at all.
      if (entry.streaming && entry.text.length === 0 && !entry.ask) continue;
      kept.push(
        entry.streaming ? { ...entry, streaming: false, stopped: !entry.ask } : entry,
      );
    } else if (
      (entry.kind === "proposal" || entry.kind === "recommendation") &&
      !decided(entry.id)
    ) {
      kept.push(entry);
    }
  }
  return kept.slice(-STORED_ENTRY_LIMIT);
}

/** The scope as it is kept: the track by ID. */
function storedScope(
  scope: AssistantScope,
): Omit<AssistantScope, "track"> & { readonly trackId: string | null } {
  return {
    level: scope.level,
    catalogScope: scope.catalogScope,
    label: scope.label,
    selection: scope.selection,
    trackId: scope.track?.id ?? null,
  };
}

/**
 * The library a sound card is checked against, cut to what it names: its pack
 * and its sounds. Null when it does not check out, which it would not when
 * restored either.
 */
function namedLibrary(
  call: AssistantToolCall,
  library: AssistantLibraryContext | null,
): AssistantLibraryContext | null {
  if (!library) return null;
  const checked = validateRecommendation(call.input, library);
  if (!checked.ok) return null;
  const { pack, sounds } = checked.recommendation;
  return { packs: [{ ...pack, sounds: [...sounds] }] };
}

/**
 * The conversation as it is kept. `decided` says which proposal and sound
 * cards the producer has decided, which are not kept; by default none is.
 */
export function serializeConversation(
  entries: readonly ConversationEntry[],
  pendingAskReplyId: string | null,
  decided: (entryId: string) => boolean = () => false,
): string {
  const kept = keepable(entries, decided);
  const pending =
    pendingAskReplyId !== null &&
    kept.some(
      (entry) => entry.kind === "reply" && entry.id === pendingAskReplyId && entry.ask,
    )
      ? pendingAskReplyId
      : null;
  const origins: (Omit<StoredOrigin, "scope"> & {
    scope: ReturnType<typeof storedScope>;
  })[] = [];
  const originIndexes = new Map<TurnOrigin, number>();
  const indexOf = (origin: TurnOrigin): number => {
    const known = originIndexes.get(origin);
    if (known !== undefined) return known;
    originIndexes.set(origin, origins.length);
    origins.push({
      text: origin.text,
      ...(origin.answers !== undefined ? { answers: origin.answers } : {}),
      ...(origin.wire !== undefined ? { wire: origin.wire } : {}),
      ...(origin.automatic ? { automatic: true as const } : {}),
      ...(origin.turnId ? { turnId: origin.turnId } : {}),
      scope: storedScope(origin.scope),
    });
    return origins.length - 1;
  };
  return JSON.stringify({
    version: 1,
    entries: kept.map((entry) => {
      switch (entry.kind) {
        case "message":
          return entry;
        case "reply":
          return {
            kind: entry.kind,
            id: entry.id,
            text: entry.text,
            stopped: entry.stopped,
            ...(entry.failed ? { failed: true } : {}),
            ...(entry.ask ? { ask: entry.ask } : {}),
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
            ...(entry.rating ? { rating: entry.rating } : {}),
            ...(entry.proposal ? { proposal: entry.proposal } : {}),
            ...(entry.lesson ? { lesson: entry.lesson } : {}),
          };
        case "proposal":
          return {
            kind: entry.kind,
            id: entry.id,
            proposal: entry.proposal,
            origin: indexOf(entry.origin),
            replyId: entry.replyId,
          };
        default:
          return {
            kind: entry.kind,
            id: entry.id,
            call: entry.call,
            library: namedLibrary(entry.call, entry.library),
            origin: indexOf(entry.origin),
          };
      }
    }),
    origins,
    pendingAskReplyId: pending,
  });
}

/**
 * A kept card's turn, against the song as it is now: the scope's track is
 * the song's own track by that ID, or none when it has gone. It counts as a
 * turn from before the reload, so its proposal comes back out of date.
 */
export function restoreOrigin(stored: StoredOrigin, project: Project): TurnOrigin {
  const { trackId, ...scope } = stored.scope;
  const track =
    trackId === null
      ? null
      : (project.song.tracks.find((candidate) => candidate.id === trackId) ?? null);
  return {
    text: stored.text,
    ...(stored.answers !== undefined ? { answers: stored.answers } : {}),
    ...(stored.wire !== undefined ? { wire: stored.wire } : {}),
    ...(stored.automatic ? { automatic: true as const } : {}),
    ...(stored.turnId ? { turnId: stored.turnId } : {}),
    scope: { ...scope, track },
    remoteChanges: 0,
    restored: true,
  };
}

/** Reads a stored conversation; anything unreadable is none, never an error. */
export function parseConversation(raw: string | null): StoredConversation | null {
  if (raw === null) return null;
  let parsed: z.infer<typeof storedSchema>;
  try {
    const result = storedSchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const entries = parsed.entries.map((entry): StoredEntry | StoredCard => {
    switch (entry.kind) {
      case "message":
        return entry;
      case "reply":
        return { ...entry, streaming: false };
      default: {
        const origin = parsed.origins[entry.origin] as StoredOrigin;
        return { ...entry, origin };
      }
    }
  });
  const asker = entries.find(
    (entry) => entry.kind === "reply" && entry.id === parsed.pendingAskReplyId,
  );
  const pendingAsk =
    asker?.kind === "reply" && asker.ask ? { ask: asker.ask, replyId: asker.id } : null;
  return { entries, pendingAsk };
}

/** Where a conversation is kept: one key's reads and writes. */
export interface ConversationStore {
  load(key: string): StoredConversation | null;
  /** `decided` says which cards are decided, and so not kept (GRV-135). */
  save(
    key: string,
    entries: readonly ConversationEntry[],
    pendingAskReplyId: string | null,
    decided?: (entryId: string) => boolean,
  ): void;
}

/** This tab's `sessionStorage`, or `null` where there is none or reading it throws. */
function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * A store over `storage`. Storage that is missing, blocked or full keeps
 * nothing: the conversation carries on in memory, as it did before.
 */
export function createConversationStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = tabStorage(),
): ConversationStore {
  return {
    load(key) {
      try {
        return parseConversation(storage?.getItem(key) ?? null);
      } catch {
        return null;
      }
    },
    save(key, entries, pendingAskReplyId, decided = () => false) {
      if (!storage) return;
      try {
        if (keepable(entries, decided).length === 0) storage.removeItem(key);
        else
          storage.setItem(
            key,
            serializeConversation(entries, pendingAskReplyId, decided),
          );
      } catch {
        // Full or blocked: this page's conversation is the one in memory.
      }
    },
  };
}
