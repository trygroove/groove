import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { skip } from "../../lessons/session";
import { startedAt, starterWorld } from "../../testing/lessonWorld";
import { transitionKey, useLessonTurns } from "./useLessonTurns";

const settings = { style: "boom_bap" } as const;

function setup() {
  const [streaming, setStreaming] = createSignal(false);
  const sendLesson = vi.fn(() => true);
  const turns = createRoot(() =>
    useLessonTurns({
      conversation: { sendLesson, streaming },
      settings: () => settings,
      done: () => [],
    }),
  );
  return { turns, sendLesson, setStreaming };
}

describe("a lesson's turns (GRV-190)", () => {
  it("sends one turn for one transition, however often it is queued", () => {
    const h = setup();
    const started = startedAt("tour", "tour-mixer", starterWorld(), settings);
    h.turns.queue(started.state, started.event);
    h.turns.queue(started.state, started.event);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    const skipped = skip(started.state, starterWorld(), settings);
    if (!skipped) throw new Error("not skipped");
    h.turns.queue(skipped.state, skipped.event);
    h.turns.queue(skipped.state, skipped.event);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(2);
  });

  it("folds the turns that waited for a reply into one, and clears what waits", () => {
    const h = setup();
    h.setStreaming(true);
    const started = startedAt("tour", "tour-mixer", starterWorld(), settings);
    h.turns.queue(started.state, started.event);
    const skipped = skip(started.state, starterWorld(), settings);
    if (!skipped) throw new Error("not skipped");
    h.turns.queue(skipped.state, skipped.event);
    flush();
    expect(h.sendLesson).not.toHaveBeenCalled();
    h.setStreaming(false);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
    expect(h.sendLesson).toHaveBeenCalledWith(
      'Let\'s do "The Mixer". Skipped "The Mixer". That was the last bite of "Tour the studio".',
      expect.objectContaining({ moment: "chapter_done" }),
      "Tour the studio",
    );

    h.setStreaming(true);
    h.turns.queue(started.state, started.event);
    h.turns.clear();
    h.setStreaming(false);
    flush();
    expect(h.sendLesson).toHaveBeenCalledTimes(1);
  });

  it("tells transitions apart by where they left the lesson and what happened", () => {
    const started = startedAt("tour", "tour-mixer", starterWorld(), settings);
    const skipped = skip(started.state, starterWorld(), settings);
    if (!skipped) throw new Error("not skipped");
    expect(transitionKey(started.state, started.event)).not.toBe(
      transitionKey(skipped.state, skipped.event),
    );
  });
});
