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
  type SessionTurn,
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

/** Each reason, made to happen on `turn`. */
const CAUSES: Record<SadReason, (health: SessionHealth, turn: SessionTurn) => void> = {
  turn_error: (health, turn) =>
    health.turnEnded({ kind: "error", code: "provider_unavailable" }, turn),
  max_tokens: (health, turn) =>
    health.turnEnded({ kind: "done", stopped: false, stopReason: "max_tokens" }, turn),
  refusal: (health, turn) =>
    health.turnEnded({ kind: "done", stopped: false, stopReason: "refusal" }, turn),
  proposal_invalid: (health, turn) => health.proposalOutcome("p1", "rejected", turn),
  proposal_stale: (health, turn) =>
    health.proposalOutcome("p1", "rejected", turn, { stale: true }),
  proposal_undone_fast: (health, turn) => {
    health.proposalOutcome("p1", "applied", turn);
    health.proposalOutcome("p1", "undone", turn);
  },
  proposal_cancelled: (health, turn) => health.proposalOutcome("p1", "cancelled", turn),
  rated_down: (health, turn) => health.rated("down", turn),
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
    expect(health.messageSent()).toEqual({ session: 1, index: 1 });
    expect(health.messageSent()).toEqual({ session: 1, index: 2 });
    expect(events()).toEqual(["started"]);
  });

  it("fires only the start for a clean conversation", () => {
    const { health, events } = setup();
    const one = health.messageSent();
    health.turnEnded({ kind: "done", stopped: false, stopReason: "end_turn" }, one);
    health.proposalOutcome("p1", "applied", one);
    const two = health.messageSent();
    health.turnEnded({ kind: "done", stopped: false, stopReason: "tool_use" }, two);
    health.rated("up", two);
    expect(events()).toEqual(["started"]);
  });

  for (const [reason, cause] of Object.entries(CAUSES) as [
    SadReason,
    (health: SessionHealth, turn: SessionTurn) => void,
  ][]) {
    const signalClass = CLASSES[reason];
    const expected =
      signalClass === "soft"
        ? [`sad:full:${reason}:soft`]
        : [`sad:full:${reason}:${signalClass}`, `sad:hard:${reason}:${signalClass}`];
    it(`fires ${expected.length === 1 ? "the full rate" : "both rates"} for ${reason}`, () => {
      const { health, events } = setup();
      cause(health, health.messageSent());
      expect(events()).toEqual(["started", ...expected]);
    });
  }

  it("carries the turn's bucket and nothing that names the conversation", () => {
    const { health, transport } = setup();
    let fifth = health.messageSent();
    for (let turn = 1; turn < 5; turn += 1) fifth = health.messageSent();
    health.turnEnded({ kind: "error", code: "timeout" }, fifth);
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
    const one = health.messageSent();
    health.turnEnded({ kind: "error", code: "timeout" }, one);
    const two = health.messageSent();
    health.turnEnded({ kind: "done", stopped: false, stopReason: "refusal" }, two);
    health.rated("down", two);
    expect(events()).toEqual([
      "started",
      "sad:full:turn_error:hard",
      "sad:hard:turn_error:hard",
    ]);
  });

  it("fires the full rate on a soft signal and the hard rate on a later hard one", () => {
    const { health, events } = setup();
    const one = health.messageSent();
    health.proposalOutcome("p1", "cancelled", one);
    health.proposalOutcome("p2", "cancelled", one);
    const two = health.messageSent();
    health.rated("down", two);
    health.turnEnded({ kind: "error", code: "timeout" }, two);
    expect(events()).toEqual([
      "started",
      "sad:full:proposal_cancelled:soft",
      "sad:hard:rated_down:explicit",
    ]);
  });

  it("counts an undo within a minute of applying, and not one at 61 seconds", () => {
    const fast = setup();
    const quick = fast.health.messageSent();
    fast.health.proposalOutcome("p1", "applied", quick);
    fast.clock.advance(FAST_UNDO_MS);
    fast.health.proposalOutcome("p1", "undone", quick);
    expect(fast.events()).toEqual(["started", "sad:full:proposal_undone_fast:soft"]);

    const slow = setup();
    const late = slow.health.messageSent();
    slow.health.proposalOutcome("p1", "applied", late);
    slow.clock.advance(61_000);
    slow.health.proposalOutcome("p1", "undone", late);
    expect(slow.events()).toEqual(["started"]);
  });

  it("times an undo from the latest apply, so a redo starts the minute again", () => {
    const { health, clock, events } = setup();
    const one = health.messageSent();
    health.proposalOutcome("p1", "applied", one);
    clock.advance(120_000);
    health.proposalOutcome("p1", "undone", one);
    health.proposalOutcome("p1", "applied", one);
    clock.advance(10_000);
    health.proposalOutcome("p1", "undone", one);
    expect(events()).toEqual(["started", "sad:full:proposal_undone_fast:soft"]);
  });

  it("does not count a turn the producer stopped or cancelled", () => {
    const { health, events } = setup();
    const one = health.messageSent();
    health.turnEnded({ kind: "done", stopped: true, stopReason: null }, one);
    health.turnEnded({ kind: "error", code: "cancelled" }, one);
    expect(events()).toEqual(["started"]);
  });

  it("counts a reply cut off on the way as max_tokens", () => {
    const { health, events } = setup();
    health.turnEnded({ kind: "error", code: "reply_too_long" }, health.messageSent());
    expect(events()).toEqual([
      "started",
      "sad:full:max_tokens:hard",
      "sad:hard:max_tokens:hard",
    ]);
  });

  it("is not sad before any message was sent", () => {
    const { health, events } = setup();
    health.rated("down", { session: 1, index: 1 });
    expect(events()).toEqual([]);
  });

  it("starts over for a new conversation, and ignores the old one's turns", () => {
    const { health, clock, events } = setup();
    const old = health.messageSent();
    health.proposalOutcome("p1", "applied", old);
    health.turnEnded({ kind: "error", code: "timeout" }, old);
    health.reset();
    // A late signal from the old conversation counts for nothing, before the
    // new one's first message or after it.
    health.rated("down", old);
    const fresh = health.messageSent();
    expect(fresh).toEqual({ session: 2, index: 1 });
    health.turnEnded({ kind: "error", code: "timeout" }, old);
    health.proposalOutcome("p9", "cancelled", old);
    clock.advance(1_000);
    // The old conversation's applied proposal is forgotten.
    health.proposalOutcome("p1", "undone", fresh);
    expect(events()).toEqual([
      "started",
      "sad:full:turn_error:hard",
      "sad:hard:turn_error:hard",
      "started",
    ]);
    health.proposalOutcome("p2", "rejected", fresh, { stale: true });
    expect(events().slice(4)).toEqual([
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
    const one = health.messageSent();
    expect(one.index).toBe(1);
    expect(() => health.rated("down", one)).not.toThrow();
  });
});

describe("assistant_turn_failed (GRV-206)", () => {
  const failures = (transport: ReturnType<typeof setup>["transport"]) =>
    transport.events
      .filter((event) => event.name === "assistant_turn_failed")
      .map(({ params }) => ({
        code: params.code,
        turn_index_bucket: params.turn_index_bucket,
      }));

  it("fires once per failed turn, with its code and turn, every time", () => {
    const { health, transport } = setup();
    const one = health.messageSent();
    health.turnEnded({ kind: "error", code: "provider_error" }, one);
    const two = health.messageSent();
    health.turnEnded({ kind: "error", code: "provider_error" }, two);
    const three = health.messageSent();
    health.turnEnded({ kind: "error", code: "refused" }, three);
    expect(failures(transport)).toEqual([
      { code: "provider_error", turn_index_bucket: "1" },
      { code: "provider_error", turn_index_bucket: "2_3" },
      { code: "refused", turn_index_bucket: "2_3" },
    ]);
  });

  it("does not fire for a turn that completed, was stopped or was cancelled", () => {
    const { health, transport } = setup();
    const one = health.messageSent();
    health.turnEnded({ kind: "done", stopped: false, stopReason: "end_turn" }, one);
    const two = health.messageSent();
    health.turnEnded({ kind: "done", stopped: true, stopReason: null }, two);
    const three = health.messageSent();
    health.turnEnded({ kind: "error", code: "cancelled" }, three);
    expect(failures(transport)).toEqual([]);
  });

  it("counts the model refusing as a refusal, not a turn error", () => {
    const { health, events } = setup();
    health.turnEnded({ kind: "error", code: "refused" }, health.messageSent());
    expect(events()).toEqual([
      "started",
      "sad:full:refusal:hard",
      "sad:hard:refusal:hard",
    ]);
  });
});
