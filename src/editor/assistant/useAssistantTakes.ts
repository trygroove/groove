/**
 * The assistant's takes cards (GRV-207): four takes of a part to pick from,
 * and what hearing, picking, "None of these" and "4 more" do to them.
 *
 * - **Hear** opens the session's uncommitted preview of one take (#851) and
 *   plays the song with it in place, from where the take starts when the
 *   song was stopped or is playing somewhere the take is not, so the take
 *   is heard in context with the rest of the track. Another take's Hear swaps the preview with the song still
 *   playing, so switching is instant; pressed again it stops, and a song it
 *   started is paused back where it was. Nothing is applied.
 * - **Use this** hands that one take on as a proposal of its own
 *   (`onPick`), which the proposal cards apply through the executor
 *   (GRV-4): one transaction, one undo entry. The other takes are discarded.
 *   Every edit checks the open cards' takes again, as it checks proposals,
 *   and picking checks the one picked once more, so a take the song no
 *   longer fits is never used: its card stays open and says so.
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
import {
  type AssistantTakes as Offer,
  parseTakesCall,
  type TakesOutcome,
} from "../../assistant/takes";
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
    "proposalTarget" | "beginPreview" | "onEdit" | "onRemoteChange" | "previewing"
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
  /**
   * How many changes made elsewhere have been adopted this session (the
   * proposal cards' count), so an offer that arrives after one more is
   * known to have had the song move under it.
   */
  remoteChanges?(): number;
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
  /** Whether "4 more" can ask again from this card: its offer parsed. */
  canMore(entryId: string): boolean;
}

/** What a card keeps beside what it shows. */
interface Entry {
  /** The offer, to check again as the song changes; null when it was malformed. */
  readonly offer: Offer | null;
  /** The call parsed as an offer, so "4 more" can name its part and takes. */
  readonly parsed: boolean;
  readonly baseRevision: number;
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
  /**
   * The cards decided (picked, declined, 4 more) or moved under from
   * elsewhere, kept apart from the signal, which a write leaves unreadable
   * until it flushes: picking applies at once, and that edit must not check
   * the card it decided again.
   */
  const closed = new Set<string>();
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
      trackName: null,
      hearing: null,
      picked: null,
      notice: null,
    };
    if (!takes || !target) {
      entries.set(entryId, {
        offer: null,
        parsed: takes !== null,
        baseRevision,
        rows: [],
        rerolls: origin.takesRerolls ?? 0,
      });
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
    entries.set(entryId, {
      offer: takes,
      parsed: true,
      baseRevision,
      rows: checked.rows,
      rerolls: origin.takesRerolls ?? 0,
    });
    // A change made elsewhere while the reply was written moved the song
    // under it, though not this session's revision, as it does a proposal's.
    const movedElsewhere =
      !origin.restored && (options.remoteChanges?.() ?? 0) !== origin.remoteChanges;
    if (movedElsewhere) closed.add(entryId);
    setCards((current) =>
      new Map(current).set(entryId, {
        ...base,
        ...shownTakes(checked.rows, checked.stale || movedElsewhere),
        trackName: shownTrackName(checked.rows),
        part: takes.part,
      }),
    );
  }

  /** The track the card names: the first fitting take's. */
  const shownTrackName = (rows: readonly TakeRow[]) =>
    rows.find((row) => row.commands !== null)?.trackName ?? null;

  /** What a card shows of its takes once checked: which fit, and so where it stands. */
  function shownTakes(
    rows: readonly TakeRow[],
    stale: boolean,
  ): Pick<TakesCard, "status" | "takes"> {
    const fitting = rows.filter((row) => row.commands !== null).length;
    return {
      status: stale ? "stale" : fitting === 0 ? "invalid" : "choosing",
      takes: rows.map((row) => ({ label: row.label, fits: row.commands !== null })),
    };
  }

  /**
   * Checks a card's takes again against the song as it is now, as a
   * proposal's are on every edit: a take an edit broke no longer fits, and
   * the card goes stale when the song moved under all of them. Returns the
   * rows it found, or null when there was nothing to check.
   */
  function recheck(entryId: string): readonly TakeRow[] | null {
    const entry = entries.get(entryId);
    const target = options.session.proposalTarget();
    if (!entry?.offer || !target) return null;
    const checked = checkTakes(target.project, entry.offer, entry.baseRevision, target);
    entries.set(entryId, { ...entry, rows: checked.rows });
    update(entryId, {
      ...shownTakes(checked.rows, checked.stale),
      trackName: shownTrackName(checked.rows),
    });
    return checked.rows;
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
    const opened = options.session.beginPreview(row.commands);
    if (!opened?.ok) {
      update(entryId, { notice: NO_LONGER_FITS });
      return;
    }
    // Another proposal's preview gives way, as theirs do to one another, but
    // only once this one opened (the session superseded theirs), so a take
    // that cannot open leaves the producer's own in place.
    options.onPreviewOpen?.();
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
    if (!audio) return;
    if (!playing) {
      if (row.startTicks !== null) audio.seekTicks(row.startTicks);
      void audio.play();
      return;
    }
    // Already playing: a take the playhead is not in is heard from its start.
    const at = audio.positionTicks();
    if (
      row.startTicks !== null &&
      row.endTicks !== null &&
      (at < row.startTicks || at >= row.endTicks)
    ) {
      audio.seekTicks(row.startTicks);
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
    // The song may have changed since the takes were last checked: only a
    // take that still fits is used, or the choice would be lost to a stale
    // proposal. One that does not leaves the card open, saying so.
    const rows = recheck(entryId);
    if (!rows?.[index]?.commands) {
      update(entryId, { notice: NO_LONGER_FITS });
      return;
    }
    closed.add(entryId);
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
    closed.add(entryId);
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
    // The history the new turn sends says these were set aside, not that the
    // producer has yet to pick; a request that could not go takes it back.
    options.onOutcome?.(entryId, "more");
    if (!options.onMore(entryId)) {
      options.onOutcome?.(entryId, "pending");
      return;
    }
    // The new turn asked about the committed song; the take heard stops now.
    if (hearing?.entryId === entryId) endHearing(true);
    closed.add(entryId);
    update(entryId, { status: "more" });
    const rerolls = (entries.get(entryId)?.rerolls ?? 0) + 1;
    logged((analytics) =>
      analytics.log("assistant_takes_rerolled", { reroll_count: rerolls }),
    );
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
  // An edit here (the producer's, an applied proposal's, an undo) is checked
  // against every offer still open, as it is against every proposal.
  onCleanup(
    options.session.onEdit(() => {
      for (const [entryId, card] of cards()) {
        if (card.status === "choosing" && !closed.has(entryId)) recheck(entryId);
      }
    }),
  );
  // A change made elsewhere moves the song under every offer still open.
  onCleanup(
    options.session.onRemoteChange(() => {
      for (const [entryId, card] of cards()) {
        if (card.status !== "choosing" || closed.has(entryId)) continue;
        if (hearing?.entryId === entryId) endHearing(true);
        closed.add(entryId);
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
    canMore: (entryId) => entries.get(entryId)?.parsed ?? false,
  };
}
