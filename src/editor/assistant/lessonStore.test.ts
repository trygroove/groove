import { describe, expect, it } from "vitest";
import {
  createLessonStore,
  LESSON_STORAGE_PREFIX,
  lessonStorageKey,
  type StoredLesson,
} from "./lessonStore";

function memory() {
  const items = new Map<string, string>();
  return {
    items,
    storage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  };
}

describe("the kept lesson (GRV-43)", () => {
  it("keeps a lesson under its conversation's key, and forgets it", () => {
    const { items, storage } = memory();
    const store = createLessonStore(storage);
    const key = lessonStorageKey("sg_assistant_conversation_v1:uid:prj");
    expect(key.startsWith(LESSON_STORAGE_PREFIX)).toBe(true);
    const lesson = {
      chapter: "beat",
      bite: "beat-snare",
      endings: { "beat-library": "skipped" },
    } as const;
    store.save(key, lesson);
    // A lesson kept without them is a chapter alone.
    expect(store.load(key)).toEqual({ ...lesson, track: false, passed: [] });
    store.save(key, null);
    expect(items.size).toBe(0);
    expect(store.load(key)).toBeNull();
  });

  it("keeps that it is Finish a track, and what its chapter passed over (GRV-44)", () => {
    const { storage } = memory();
    const store = createLessonStore(storage);
    const lesson: StoredLesson = {
      chapter: "beat",
      bite: "beat-play",
      endings: { "beat-library": "did_it" },
      track: true,
      passed: ["beat-kick"],
    };
    store.save("key", lesson);
    expect(store.load("key")).toEqual(lesson);
  });

  it("drops what it cannot read back", () => {
    const { items, storage } = memory();
    const store = createLessonStore(storage);
    for (const raw of [
      "{",
      JSON.stringify({ version: 2, chapter: "beat", bite: "beat-kick", endings: {} }),
      JSON.stringify({ version: 1, chapter: "jazz", bite: "beat-kick", endings: {} }),
    ]) {
      items.set("key", raw);
      expect(store.load("key")).toBeNull();
    }
  });

  it("keeps nothing without storage", () => {
    const store = createLessonStore(null);
    store.save("key", { chapter: "tour", bite: "tour-mixer", endings: {} });
    expect(store.load("key")).toBeNull();
  });
});
