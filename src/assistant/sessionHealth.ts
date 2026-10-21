/**
 * Whether the open assistant conversation went wrong (GRV-103): the one
 * detector behind the sad-session rate.
 *
 * A **session** is one conversation with at least one sent message; its first
 * message logs `assistant_session_started`. A session is **sad** once any turn
 * in it had a bad response, and stays sad whatever happens after. Each bad
 * signal has a reason and a class:
 *
 * - **hard** (the system): a turn that failed, was cut off (`max_tokens`) or
 *   refused, or a proposal rejected as invalid or stale;
 * - **soft** (the producer's reaction): a proposal undone within
 *   {@link FAST_UNDO_MS} of applying, or turned down;
 * - **explicit**: a reply rated down.
 *
 * `assistant_session_sad` fires at most once per class group, so a soft signal
 * never uses up the hard rate's one event: with `counts_for: full` on the
 * session's first bad signal of any class, and with `counts_for: hard` on its
 * first hard or explicit one. A first signal that is hard or explicit fires
 * both. The two rates are then plain event counts over
 * `assistant_session_started`, on any transport.
 *
 * Signals come from the paths that already exist (the turn's end, a
 * proposal's outcome, the rating control). The one other event here is
 * `assistant_turn_failed`, once for every turn that ends in an error other
 * than a cancel (GRV-206), so an alert can count failures by their code.
 * Framework-free, with the clock injected. A new conversation resets it, and
 * from then on a signal from one of the old conversation's turns (a late
 * error, an outcome on one of its cards) counts for nothing.
 */
import type { Analytics } from "../analytics/analytics";
import { bucketOf } from "../analytics/buckets";
import type {
  ASSISTANT_SAD_REASONS,
  ASSISTANT_SAD_SIGNAL_CLASSES,
} from "../analytics/catalog/assistant";
import type { Clock } from "../shared/clock";
import type { AssistantErrorCode, AssistantStopReason } from "./protocol";
import type { ProposalOutcome, ReplyRating } from "./transcripts";

export type SadReason = (typeof ASSISTANT_SAD_REASONS)[number];
export type SadSignalClass = (typeof ASSISTANT_SAD_SIGNAL_CLASSES)[number];

/** Each reason's class. */
export const SAD_SIGNAL_CLASSES: Readonly<Record<SadReason, SadSignalClass>> = {
  turn_error: "hard",
  max_tokens: "hard",
  refusal: "hard",
  proposal_invalid: "hard",
  proposal_stale: "hard",
  proposal_undone_fast: "soft",
  proposal_cancelled: "soft",
  rated_down: "explicit",
};

/** An undo this soon after applying, or sooner, says the proposal was wrong. */
export const FAST_UNDO_MS = 60_000;

/**
 * One turn of one session, as {@link SessionHealth.messageSent} hands it out:
 * which session (it changes on every reset) and which turn of it, from 1.
 */
export interface SessionTurn {
  readonly session: number;
  readonly index: number;
}

/** How a turn ended, as the conversation saw it. */
export type TurnEnding =
  | { readonly kind: "error"; readonly code: AssistantErrorCode }
  | {
      readonly kind: "done";
      /** The producer pressed Stop. */
      readonly stopped: boolean;
      readonly stopReason: AssistantStopReason | null;
    };

/**
 * The bad response a turn's ending is, if it is one. A turn the producer
 * stopped, or cancelled, is their choice, not the assistant's failure.
 */
export function turnSadReason(ending: TurnEnding): SadReason | null {
  if (ending.kind === "error") {
    if (ending.code === "cancelled") return null;
    if (ending.code === "refused") return "refusal";
    return ending.code === "reply_too_long" ? "max_tokens" : "turn_error";
  }
  if (ending.stopped) return null;
  if (ending.stopReason === "max_tokens") return "max_tokens";
  if (ending.stopReason === "refusal") return "refusal";
  return null;
}

export interface SessionHealthOptions {
  readonly clock: Clock;
  readonly analytics: () => Analytics;
}

export interface SessionHealth {
  /**
   * A message was sent: a new turn. The first of a session logs
   * `assistant_session_started`. Returns the turn, which every later signal
   * about it names.
   */
  messageSent(): SessionTurn;
  /** The turn `turn` ended so. */
  turnEnded(ending: TurnEnding, turn: SessionTurn): void;
  /**
   * What became of the proposal `key` (a card's entry ID) from turn `turn`.
   * `stale` says a rejected one was rejected because the song moved on.
   */
  proposalOutcome(
    key: string,
    outcome: ProposalOutcome,
    turn: SessionTurn,
    options?: { readonly stale?: boolean },
  ): void;
  /** The reply from turn `turn` was rated so. */
  rated(rating: ReplyRating, turn: SessionTurn): void;
  /**
   * A new conversation: forgets everything, so its first message starts a
   * session, and ignores every turn handed out before.
   */
  reset(): void;
}

export function createSessionHealth(options: SessionHealthOptions): SessionHealth {
  /** Which session this is: one more on every reset. */
  let session = 1;
  let turns = 0;
  let sadFull = false;
  let sadHard = false;
  /** When each proposal was last applied, by its key. */
  const appliedAt = new Map<string, number>();

  function log(name: "full" | "hard", reason: SadReason, turn: SessionTurn): void {
    try {
      options.analytics().log("assistant_session_sad", {
        reason,
        signal_class: SAD_SIGNAL_CLASSES[reason],
        turn_index_bucket: bucketOf("turn_index", turn.index),
        counts_for: name,
      });
    } catch {
      // Measuring a bad session must never make it worse.
    }
  }

  /**
   * Whether `turn` is one of this session's: an old conversation's counts for
   * nothing, and before a message has been sent there is no turn to name.
   */
  const current = (turn: SessionTurn) => turn.session === session && turns > 0;

  function signal(reason: SadReason, turn: SessionTurn): void {
    if (!current(turn)) return;
    const hard = SAD_SIGNAL_CLASSES[reason] !== "soft";
    if (!sadFull) {
      sadFull = true;
      log("full", reason, turn);
    }
    if (hard && !sadHard) {
      sadHard = true;
      log("hard", reason, turn);
    }
  }

  return {
    messageSent() {
      turns += 1;
      if (turns === 1) {
        try {
          options.analytics().log("assistant_session_started", {});
        } catch {
          // As above.
        }
      }
      return { session, index: turns };
    },
    turnEnded(ending, turn) {
      // Every failed turn, sad session or not, old conversation or new
      // (GRV-206): what an alert on a failing provider counts.
      if (ending.kind === "error" && ending.code !== "cancelled") {
        try {
          options.analytics().log("assistant_turn_failed", {
            code: ending.code,
            turn_index_bucket: bucketOf("turn_index", turn.index),
          });
        } catch {
          // As above.
        }
      }
      const reason = turnSadReason(ending);
      if (reason) signal(reason, turn);
    },
    proposalOutcome(key, outcome, turn, outcomeOptions) {
      if (!current(turn)) return;
      const now = options.clock.now();
      switch (outcome) {
        case "applied":
          appliedAt.set(key, now);
          return;
        case "undone": {
          const applied = appliedAt.get(key);
          appliedAt.delete(key);
          if (applied !== undefined && now - applied <= FAST_UNDO_MS) {
            signal("proposal_undone_fast", turn);
          }
          return;
        }
        case "cancelled":
          signal("proposal_cancelled", turn);
          return;
        case "rejected":
          signal(outcomeOptions?.stale ? "proposal_stale" : "proposal_invalid", turn);
      }
    },
    rated(rating, turn) {
      if (rating === "down") signal("rated_down", turn);
    },
    reset() {
      session += 1;
      turns = 0;
      sadFull = false;
      sadHard = false;
      appliedAt.clear();
    },
  };
}
