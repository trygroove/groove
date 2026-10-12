import { describe, expect, it } from "vitest";
import { Analytics } from "../analytics/analytics";
import { createRecordingTransport } from "../analytics/transport";
import { createManualClock } from "../shared/clock";
import { memoryStorage } from "../testing/storage";
import {
  createSessionHealth,
  FAST_UNDO_MS,
  type SadReason,
  type SessionHealth,
} from "./sessionHealth";

function setup() {
  const transport = createRecordingTransport();
  const analytics = new Analytics({ transport, storage: memoryStorage() });
  const clock = createManualClock(1_000_000);
  const health = createSessionHealth({ clock, analytics: () => analytics });
  const events = () =>
    transport.events
      .filter((event) => event.name.startsWith("assistant_session_"))
      .map((event) =>
        event.name === "assistant_session_sad"
          ? `sad:${event.params.counts_for}:${event.params.reason}:${event.params.signal_class}`
          : "started",
      );
  return { health, clock, transport, events };
}

/** Each reason, made to happen on turn 1 of a fresh session. */
const CAUSES: Record<SadReason, (health: SessionHealth) => void> = {
  turn_error: (health) =>
    health.turnEnded({ kind: "error", code: "provider_unavailable" }, 1),
  max_tokens: (health) =>
    health.turnEnded({ kind: "done", stopped: false, stopReason: "max_tokens" }, 1),
  refusal: (health) =>
    health.turnEnded({ kind: "done", stopped: false, stopReason: "refusal" }, 1),
  proposal_invalid: (health) => health.proposalOutcome("p1", "rejected", 1),
  proposal_stale: (health) =>
    health.proposalOutcome("p1", "rejected", 1, { stale: true }),
  proposal_undone_fast: (health) => {
    health.proposalOutcome("p1", "applied", 1);
    health.proposalOutcome("p1", "undone", 1);
  },
  proposal_cancelled: (health) => health.proposalOutcome("p1", "cancelled", 1),
  rated_down: (health) => health.rated("down", 1),
};

const CLASSES: Record<SadReason, string> = {
  turn_error: "hard",
  max_tokens: "hard",
  refusal: "hard",
  proposal_invalid: "hard",
  proposal_stale: "hard",
  proposal_undone_fast: "soft",
  proposal_cancelled: "soft",
  rated_down: "explicit",
};

describe("session health (GRV-103)", () => {
  it("starts a session on the first sent message, once", () => {
    const { health, events } = setup();
    expect(health.messageSent()).toBe(1);
    expect(health.messageSent()).toBe(2);
    expect(events()).toEqual(["started"]);
  });

  it("fires only the start for a clean conversation", () => {
    const { health, events } = setup();
    health.messageSent();
    health.turnEnded({ kind: "done", stopped: false, stopReason: "end_turn" }, 1);
    health.proposalOutcome("p1", "applied", 1);
    health.messageSent();
    health.turnEnded({ kind: "done", stopped: false, stopReason: "tool_use" }, 2);
    health.rated("up", 2);
    expect(events()).toEqual(["started"]);
  });

  for (const [reason, cause] of Object.entries(CAUSES) as [
    SadReason,
    (health: SessionHealth) => void,
  ][]) {
    const signalClass = CLASSES[reason];
    const expected =
      signalClass === "soft"
        ? [`sad:full:${reason}:soft`]
        : [`sad:full:${reason}:${signalClass}`, `sad:hard:${reason}:${signalClass}`];
    it(`fires ${expected.length === 1 ? "the full rate" : "both rates"} for ${reason}`, () => {
      const { health, events } = setup();
      health.messageSent();
      cause(health);
      expect(events()).toEqual(["started", ...expected]);
    });
  }

  it("carries the turn's bucket and nothing that names the conversation", () => {
    const { health, transport } = setup();
    for (let turn = 0; turn < 5; turn += 1) health.messageSent();
    health.turnEnded({ kind: "error", code: "timeout" }, 5);
    const sad = transport.named("assistant_session_sad")[0]?.params ?? {};
    expect(sad).toMatchObject({
      reason: "turn_error",
      signal_class: "hard",
      turn_index_bucket: "4_10",
      counts_for: "full",
    });
    const started = transport.named("assistant_session_started")[0]?.params ?? {};
    for (const params of [sad, started]) {
      expect(
        Object.keys(params).filter((key) => /conversation|turn_id/.test(key)),
      ).toEqual([]);
    }
  });

  it("fires nothing for a second bad turn of the same class group", () => {
    const { health, events } = setup();
    health.messageSent();
    health.turnEnded({ kind: "error", code: "timeout" }, 1);
    health.messageSent();
    health.turnEnded({ kind: "done", stopped: false, stopReason: "refusal" }, 2);
    health.rated("down", 2);
    expect(events()).toEqual([
      "started",
      "sad:full:turn_error:hard",
      "sad:hard:turn_error:hard",
    ]);
  });

  it("fires the full rate on a soft signal and the hard rate on a later hard one", () => {
    const { health, events } = setup();
    health.messageSent();
    health.proposalOutcome("p1", "cancelled", 1);
    health.proposalOutcome("p2", "cancelled", 1);
    health.messageSent();
    health.rated("down", 2);
    health.turnEnded({ kind: "error", code: "timeout" }, 2);
    expect(events()).toEqual([
      "started",
      "sad:full:proposal_cancelled:soft",
      "sad:hard:rated_down:explicit",
    ]);
  });

  it("counts an undo within a minute of applying, and not one at 61 seconds", () => {
    const fast = setup();
    fast.health.messageSent();
    fast.health.proposalOutcome("p1", "applied", 1);
    fast.clock.advance(FAST_UNDO_MS);
    fast.health.proposalOutcome("p1", "undone", 1);
    expect(fast.events()).toEqual(["started", "sad:full:proposal_undone_fast:soft"]);

    const slow = setup();
    slow.health.messageSent();
    slow.health.proposalOutcome("p1", "applied", 1);
    slow.clock.advance(61_000);
    slow.health.proposalOutcome("p1", "undone", 1);
    expect(slow.events()).toEqual(["started"]);
  });

  it("times an undo from the latest apply, so a redo starts the minute again", () => {
    const { health, clock, events } = setup();
    health.messageSent();
    health.proposalOutcome("p1", "applied", 1);
    clock.advance(120_000);
    health.proposalOutcome("p1", "undone", 1);
    health.proposalOutcome("p1", "applied", 1);
    clock.advance(10_000);
    health.proposalOutcome("p1", "undone", 1);
    expect(events()).toEqual(["started", "sad:full:proposal_undone_fast:soft"]);
  });

  it("does not count a turn the producer stopped or cancelled", () => {
    const { health, events } = setup();
    health.messageSent();
    health.turnEnded({ kind: "done", stopped: true, stopReason: null }, 1);
    health.turnEnded({ kind: "error", code: "cancelled" }, 1);
    expect(events()).toEqual(["started"]);
  });

  it("counts a reply cut off on the way as max_tokens", () => {
    const { health, events } = setup();
    health.messageSent();
    health.turnEnded({ kind: "error", code: "reply_too_long" }, 1);
    expect(events()).toEqual([
      "started",
      "sad:full:max_tokens:hard",
      "sad:hard:max_tokens:hard",
    ]);
  });

  it("is not sad before any message was sent", () => {
    const { health, events } = setup();
    health.rated("down", 1);
    expect(events()).toEqual([]);
  });

  it("starts over for a new conversation", () => {
    const { health, clock, events } = setup();
    health.messageSent();
    health.proposalOutcome("p1", "applied", 1);
    health.turnEnded({ kind: "error", code: "timeout" }, 1);
    health.reset();
    // A sad signal before the new conversation's first message counts for nothing.
    health.rated("down", 1);
    expect(health.messageSent()).toBe(1);
    clock.advance(1_000);
    // The old conversation's applied proposal is forgotten.
    health.proposalOutcome("p1", "undone", 1);
    health.proposalOutcome("p2", "rejected", 1, { stale: true });
    expect(events()).toEqual([
      "started",
      "sad:full:turn_error:hard",
      "sad:hard:turn_error:hard",
      "started",
      "sad:full:proposal_stale:hard",
      "sad:hard:proposal_stale:hard",
    ]);
  });

  it("keeps working when analytics throws", () => {
    const throwing = {
      log() {
        throw new Error("down");
      },
    } as unknown as Analytics;
    const health = createSessionHealth({
      clock: createManualClock(),
      analytics: () => throwing,
    });
    expect(health.messageSent()).toBe(1);
    expect(() => health.rated("down", 1)).not.toThrow();
  });
});
