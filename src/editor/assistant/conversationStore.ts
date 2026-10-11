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
 * reads another's. Only messages and finished replies are kept: proposal and
 * recommendation cards, errors and a reply still streaming are not (a reply
 * cut off by the reload is kept as stopped). Whatever cannot be read back, a
 * corrupt entry or one written by an older shape, is dropped, never repaired.
 */
import { z } from "zod";
import { type AssistantAsk, assistantAskSchema } from "../../assistant/ask";
import type { ConversationEntry } from "./useAssistantConversation";

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
  }),
  z.object({
    kind: z.literal("reply"),
    id: entryId,
    text: z.string(),
    stopped: z.boolean(),
    failed: z.boolean().optional(),
    ask: assistantAskSchema.optional(),
  }),
]);

const storedSchema = z.object({
  version: z.literal(1),
  entries: z.array(storedEntrySchema),
  /** The reply whose question is still waiting, or null. */
  pendingAskReplyId: entryId.nullable(),
});

type StoredEntry = Extract<ConversationEntry, { kind: "message" | "reply" }>;

/** A conversation as it is kept and read back. */
export interface StoredConversation {
  readonly entries: readonly StoredEntry[];
  /** The question still waiting, and the reply that asked it. */
  readonly pendingAsk: { readonly ask: AssistantAsk; readonly replyId: string } | null;
}

/** What is kept of `entries`: messages and replies, a streaming one as stopped. */
function keepable(entries: readonly ConversationEntry[]): StoredEntry[] {
  const kept: StoredEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "message") kept.push(entry);
    else if (entry.kind === "reply") {
      // A reply the reload cut off is one that was stopped, or nothing at all.
      if (entry.streaming && entry.text.length === 0 && !entry.ask) continue;
      kept.push(
        entry.streaming ? { ...entry, streaming: false, stopped: !entry.ask } : entry,
      );
    }
  }
  return kept.slice(-STORED_ENTRY_LIMIT);
}

export function serializeConversation(
  entries: readonly ConversationEntry[],
  pendingAskReplyId: string | null,
): string {
  const kept = keepable(entries);
  const pending =
    pendingAskReplyId !== null &&
    kept.some(
      (entry) => entry.kind === "reply" && entry.id === pendingAskReplyId && entry.ask,
    )
      ? pendingAskReplyId
      : null;
  return JSON.stringify({
    version: 1,
    entries: kept.map((entry) =>
      entry.kind === "message"
        ? entry
        : {
            kind: entry.kind,
            id: entry.id,
            text: entry.text,
            stopped: entry.stopped,
            ...(entry.failed ? { failed: true } : {}),
            ...(entry.ask ? { ask: entry.ask } : {}),
          },
    ),
    pendingAskReplyId: pending,
  });
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
  const entries: StoredEntry[] = parsed.entries.map((entry) =>
    entry.kind === "message" ? entry : { ...entry, streaming: false },
  );
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
  save(
    key: string,
    entries: readonly ConversationEntry[],
    pendingAskReplyId: string | null,
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
    save(key, entries, pendingAskReplyId) {
      if (!storage) return;
      try {
        if (keepable(entries).length === 0) storage.removeItem(key);
        else storage.setItem(key, serializeConversation(entries, pendingAskReplyId));
      } catch {
        // Full or blocked: this page's conversation is the one in memory.
      }
    },
  };
}
