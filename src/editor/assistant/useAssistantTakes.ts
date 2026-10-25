/**
 * The assistant's takes cards (GRV-207): four takes of a part to pick from,
 * and what hearing, picking, "None of these" and "4 more" do to them.
 *
 * - **Hear** opens the session's uncommitted preview of one take (#851) and
 *   plays the song with it in place, from where the take starts when the
 *   song was stopped, so the take is heard in context with the rest of the
 *   track. Another take's Hear swaps the preview with the song still
 *   playing, so switching is instant; pressed again it stops, and a song it
 *   started is paused back where it was. Nothing is applied.
 * - **Use this** hands that one take on as a proposal of its own
 *   (`onPick`), which the proposal cards apply through the executor
 *   (GRV-4): one transaction, one undo entry. The other takes are discarded.
 * - **None of these** applies nothing and sets them all aside.
 * - **4 more** asks again for a fresh set (`onMore`), one new turn, which
 *   replaces this card's takes with its own.
 *
 * Analytics: `assistant_take_picked` with the take's position (1 to 4),
 * `assistant_takes_declined`, and `assistant_takes_rerolled`, each with how
 * many takes fitted and how many times "4 more" was pressed for the part.
 * Never a take's notes, its label or the part's name.
 *
 * Nothing here mutates a project itself: the preview goes through the editor
 * session, and the pick through the proposal path.
 */
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import type { AssistantToolCall } from "../../assistant/protocol";
import { parseTakesCall, type TakesOutcome } from "../../assistant/takes";
import type { Project } from "../../domain/entities";
import type { Preview } from "../composition/sessionPreview";
import type { ProjectAudioControls } from "../composition/useProjectAudio";
import { checkTakes, type TakeRow, type TakesCard } from "./takesCardModel";
import type { TurnOrigin } from "./useAssistantConversation";
import type { ProposalSessionPort } from "./useAssistantProposals";

/** What hearing a take needs of the song's playback. */
export type TakesAudioPort = Pick<
  ProjectAudioControls,
  "isPlaying" | "play" | "pause" | "positionTicks" | "seekTicks"
>;

export interface UseAssistantTakesOptions {
  readonly session: Pick<
    ProposalSessionPort,
    "proposalTarget" | "beginPreview" | "onRemoteChange" | "previewing"
  >;
  /** The song's playback, which a take is heard through. Without it, nothing plays. */
  readonly audio?: TakesAudioPort;
  /** The project on screen; a change to it is when a preview may have ended. */
  readonly project: Accessor<Project | null>;
  readonly analytics: () => Analytics;
  /** Ends every proposal card's open preview, as a take's opens (one at a time). */
  onPreviewOpen?(): void;
  /** The producer picked take `index` (from 0) of the offer in `entryId`. */
  onPick(entryId: string, index: number): void;
  /** "4 more" on the offer in `entryId`; whether the new turn went. */
  onMore(entryId: string): boolean;
  /** Hears what became of an offer, for the conversation's history. */
  onOutcome?(entryId: string, outcome: TakesOutcome, picked?: number): void;
}

export interface AssistantTakes {
  /** The card for a conversation entry. Reactive. */
  card(entryId: string): TakesCard | undefined;
  /** An offer arrived in a reply: check its takes against the song and show its card. */
  receive(
    entryId: string,
    call: AssistantToolCall,
    baseRevision: number,
    origin: TurnOrigin,
  ): void;
  /** Hear take `index` in the song, or, pressed again, stop. */
  hear(entryId: string, index: number): void;
  /** Stops hearing whatever take of this card is playing. */
  stopHearing(entryId: string): void;
  /** "Use this": take `index` becomes the proposal that is applied. */
  pick(entryId: string, index: number): void;
  /** "None of these": nothing is applied. */
  decline(entryId: string): void;
  /** "4 more": a fresh set replaces these. */
  more(entryId: string): void;
  /** Whether the card has been decided, so the turn's next card can come up. Reactive. */
  decided(entryId: string): boolean;
}

/** What a card keeps beside what it shows. */
interface Entry {
  readonly rows: readonly TakeRow[];
  /** How many times "4 more" was pressed for the part before this offer. */
  readonly rerolls: number;
}

/** What {@link AssistantTakes.hear} started, so stopping can undo it. */
interface Hearing {
  readonly entryId: string;
  readonly index: number;
  readonly preview: Preview;
  /** The song was stopped, so stopping pauses it back where it was. */
  readonly startedSong: boolean;
  readonly from: number;
}

const NO_LONGER_FITS = "That take no longer fits the song as it is.";

export function useAssistantTakes(options: UseAssistantTakesOptions): AssistantTakes {
  const [cards, setCards] = createSignal<ReadonlyMap<string, TakesCard>>(new Map());
  const entries = new Map<string, Entry>();
  let hearing: Hearing | null = null;

  const update = (entryId: string, change: Partial<TakesCard>) =>
    setCards((current) => {
      const card = current.get(entryId);
      if (!card) return current;
      return new Map(current).set(entryId, { ...card, notice: null, ...change });
    });

  function receive(
    entryId: string,
    call: AssistantToolCall,
    baseRevision: number,
    origin: TurnOrigin,
  ): void {
    const takes = parseTakesCall(call);
    const target = options.session.proposalTarget();
    const base = {
      scopeLabel: origin.scope.label,
      hearing: null,
      picked: null,
      notice: null,
    };
    if (!takes || !target) {
      entries.set(entryId, { rows: [], rerolls: origin.takesRerolls ?? 0 });
      setCards((current) =>
        new Map(current).set(entryId, {
          ...base,
          status: "invalid",
          part: takes?.part ?? "Takes",
          takes: [],
        }),
      );
      return;
    }
    const checked = checkTakes(target.project, takes, baseRevision, target);
    const fitting = checked.rows.filter((row) => row.commands !== null).length;
    entries.set(entryId, { rows: checked.rows, rerolls: origin.takesRerolls ?? 0 });
    setCards((current) =>
      new Map(current).set(entryId, {
        ...base,
        status: checked.stale ? "stale" : fitting === 0 ? "invalid" : "choosing",
        part: takes.part,
        takes: checked.rows.map((row) => ({
          label: row.label,
          fits: row.commands !== null,
        })),
      }),
    );
  }

  /** Puts away what is being heard; a song the hearing started is paused back. */
  function endHearing(restoreSong: boolean): void {
    const ending = hearing;
    hearing = null;
    if (!ending) return;
    ending.preview.cancel();
    update(ending.entryId, { hearing: null });
    if (restoreSong && ending.startedSong && options.audio) {
      options.audio.pause();
      options.audio.seekTicks(ending.from);
    }
  }

  function hear(entryId: string, index: number): void {
    if (hearing?.entryId === entryId && hearing.index === index) {
      endHearing(true);
      return;
    }
    const card = cards().get(entryId);
    const row = entries.get(entryId)?.rows[index];
    if (card?.status !== "choosing" || !row?.commands) return;
    // The take heard before, if any: the session ends its preview as this
    // one opens, with the song still playing, so switching is instant.
    const previous = hearing;
    // Another proposal's preview gives way, as theirs do to one another.
    options.onPreviewOpen?.();
    const opened = options.session.beginPreview(row.commands);
    if (!opened?.ok) {
      update(entryId, { notice: NO_LONGER_FITS });
      return;
    }
    if (previous && previous.entryId !== entryId)
      update(previous.entryId, { hearing: null });
    const audio = options.audio;
    const playing = audio?.isPlaying() ?? false;
    hearing = {
      entryId,
      index,
      preview: opened.preview,
      startedSong: previous ? previous.startedSong : !playing,
      from: previous ? previous.from : (audio?.positionTicks() ?? 0),
    };
    update(entryId, { hearing: index });
    if (audio && !playing) {
      if (row.startTicks !== null) audio.seekTicks(row.startTicks);
      void audio.play();
    }
  }

  function stopHearing(entryId: string): void {
    if (hearing?.entryId === entryId) endHearing(true);
  }

  /** How many of the card's takes fit the song, for its analytics. */
  const fitting = (entryId: string) =>
    entries.get(entryId)?.rows.filter((row) => row.commands !== null).length ?? 0;

  function logged(log: (analytics: Analytics) => void): void {
    try {
      const analytics = options.analytics();
      log(analytics);
      analytics.logFeatureFirstUse("assistant_takes");
    } catch {
      // The decision stands; an analytics failure is not this card's.
    }
  }

  function pick(entryId: string, index: number): void {
    const card = cards().get(entryId);
    const entry = entries.get(entryId);
    if (card?.status !== "choosing" || !entry?.rows[index]?.commands) return;
    // The take is heard no more: what applies is the proposal it becomes.
    if (hearing?.entryId === entryId) endHearing(true);
    update(entryId, { status: "picked", picked: index });
    logged((analytics) =>
      analytics.log("assistant_take_picked", {
        position: index + 1,
        take_count: fitting(entryId),
        reroll_count: entry.rerolls,
      }),
    );
    options.onOutcome?.(entryId, "picked", index + 1);
    options.onPick(entryId, index);
  }

  function decline(entryId: string): void {
    const status = cards().get(entryId)?.status;
    if (status !== "choosing" && status !== "stale" && status !== "invalid") return;
    if (hearing?.entryId === entryId) endHearing(true);
    update(entryId, { status: "declined" });
    const rerolls = entries.get(entryId)?.rerolls ?? 0;
    logged((analytics) =>
      analytics.log("assistant_takes_declined", {
        take_count: fitting(entryId),
        reroll_count: rerolls,
      }),
    );
    options.onOutcome?.(entryId, "none");
  }

  function more(entryId: string): void {
    const status = cards().get(entryId)?.status;
    if (status !== "choosing" && status !== "stale" && status !== "invalid") return;
    if (!options.onMore(entryId)) return;
    // The new turn asked about the committed song; the take heard stops now.
    if (hearing?.entryId === entryId) endHearing(true);
    update(entryId, { status: "more" });
    const rerolls = (entries.get(entryId)?.rerolls ?? 0) + 1;
    logged((analytics) =>
      analytics.log("assistant_takes_rerolled", { reroll_count: rerolls }),
    );
    options.onOutcome?.(entryId, "more");
  }

  /** A take's preview the session ended by itself (an edit, another preview) is heard no more. */
  function reconcile(): void {
    if (hearing && hearing.preview.status !== "open") {
      const ended = hearing;
      hearing = null;
      update(ended.entryId, { hearing: null });
    }
  }

  // The preview opening or closing, and the project on screen changing under
  // it (a preview superseded keeps one open), are the reactive reads; the
  // card writes are the apply half's.
  createEffect(
    () => [options.session.previewing(), options.project()] as const,
    () => reconcile(),
  );
  // A change made elsewhere moves the song under every offer still open.
  onCleanup(
    options.session.onRemoteChange(() => {
      for (const [entryId, card] of cards()) {
        if (card.status !== "choosing") continue;
        if (hearing?.entryId === entryId) endHearing(true);
        update(entryId, { status: "stale" });
      }
    }),
  );
  onCleanup(() => endHearing(true));

  return {
    card: (entryId) => cards().get(entryId),
    receive,
    hear,
    stopHearing,
    pick,
    decline,
    more,
    decided(entryId) {
      const status = cards().get(entryId)?.status;
      return (
        status === "picked" ||
        status === "declined" ||
        status === "more" ||
        status === "invalid"
      );
    },
  };
}
