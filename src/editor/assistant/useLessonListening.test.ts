import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import type { LoopRange } from "../../audio/loopRange";
import { TICKS_PER_BAR } from "../../domain/time";
import type { TrackLevel } from "../tracks/trackLevels";
import { loopWrapped, useLessonListening } from "./useLessonListening";

function setup() {
  const [playing, setPlaying] = createSignal(false);
  const [position, setPosition] = createSignal(0);
  const [level, setLevel] = createSignal<TrackLevel | null>(null);
  const [loop, setLoop] = createSignal<LoopRange | null>(null);
  const counts = createRoot(() =>
    useLessonListening({ playing, positionTicks: position, masterLevel: level, loop }),
  );
  flush();
  const at = (bar: number) => {
    setPosition(bar * TICKS_PER_BAR + 10);
    flush();
  };
  return { counts, setPlaying, setLevel, setPosition, setLoop, at };
}

describe("what Finish a track listens for (GRV-44)", () => {
  it("counts the bars heard since the song last started, loops and all", () => {
    const h = setup();
    h.setPlaying(true);
    flush();
    h.at(1);
    h.at(2);
    expect(h.counts.bar()).toBe(2);
    expect(h.counts.barsHeard()).toBe(2);
    // The loop brace sends it back to bar 1: still a bar heard.
    h.at(0);
    expect(h.counts.barsHeard()).toBe(3);
    // A seek back inside the bar is not a bar heard.
    h.setPosition(TICKS_PER_BAR / 2);
    flush();
    h.setPosition(5);
    flush();
    expect(h.counts.barsHeard()).toBe(3);
    // A one-bar loop goes round inside the same bar: each time round is one.
    h.setLoop({ startTicks: 0, endTicks: TICKS_PER_BAR });
    h.setPosition(TICKS_PER_BAR - 20);
    flush();
    h.setPosition(5);
    flush();
    expect(h.counts.bar()).toBe(0);
    expect(h.counts.barsHeard()).toBe(4);
    // Stopped, the count is gone, so starting again starts from none.
    h.setPlaying(false);
    flush();
    expect(h.counts.barsHeard()).toBe(0);
    h.setPlaying(true);
    flush();
    expect(h.counts.barsHeard()).toBe(0);
    h.at(1);
    expect(h.counts.barsHeard()).toBe(1);
  });

  it("counts each time the master goes red while the song plays, once however long it stays lit", () => {
    const h = setup();
    h.setLevel({ db: -1, clipping: true });
    flush();
    // Not playing: a clip from an audition is not the song's.
    expect(h.counts.masterClips()).toBe(0);
    h.setLevel(null);
    h.setPlaying(true);
    flush();
    h.setLevel({ db: -1, clipping: true });
    flush();
    h.setLevel({ db: -2, clipping: true });
    flush();
    expect(h.counts.masterClips()).toBe(1);
    h.setLevel({ db: -9, clipping: false });
    flush();
    h.setLevel({ db: -1, clipping: true });
    flush();
    expect(h.counts.masterClips()).toBe(2);
    // Stopped, the clips are forgotten: playing again starts clean.
    h.setPlaying(false);
    flush();
    expect(h.counts.masterClips()).toBe(0);
  });

  it("counts stem exports, not stereo ones", () => {
    const h = setup();
    h.counts.exported("stereo");
    h.counts.exported("stems");
    flush();
    expect(h.counts.stemExports()).toBe(1);
  });
});

describe("a loop going round (GRV-44)", () => {
  const loop = { startTicks: 4 * TICKS_PER_BAR, endTicks: 8 * TICKS_PER_BAR };
  it("is the playhead going from the loop's last bar back to its first", () => {
    expect(loopWrapped(loop, 8 * TICKS_PER_BAR - 10, 4 * TICKS_PER_BAR + 5)).toBe(true);
  });
  it("is not a seek back, nor anything without a loop", () => {
    expect(loopWrapped(loop, 6 * TICKS_PER_BAR, 5 * TICKS_PER_BAR)).toBe(false);
    expect(loopWrapped(null, 8 * TICKS_PER_BAR - 10, 4 * TICKS_PER_BAR + 5)).toBe(false);
    expect(loopWrapped(loop, 4 * TICKS_PER_BAR + 5, 8 * TICKS_PER_BAR - 10)).toBe(false);
  });
});
