import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getLessonRepository", () => {
  it("hands the mock backend one shared in-memory store", async () => {
    vi.stubEnv("VITE_DEV_BACKEND", "mock");
    const { getLessonRepository } = await import("./lessonRepositoryClient");
    const { InMemoryLessonRepository } = await import(
      "./persistence/inMemoryLessonRepository"
    );

    const first = await getLessonRepository();
    expect(first).toBeInstanceOf(InMemoryLessonRepository);
    expect(await getLessonRepository()).toBe(first);
  });
});
