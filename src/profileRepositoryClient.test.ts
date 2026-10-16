import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getProfileRepository", () => {
  it("hands the mock backend one shared in-memory store", async () => {
    vi.stubEnv("VITE_DEV_BACKEND", "mock");
    const { getProfileRepository } = await import("./profileRepositoryClient");
    const { InMemoryProfileRepository } = await import(
      "./persistence/inMemoryProfileRepository"
    );

    const first = await getProfileRepository();
    expect(first).toBeInstanceOf(InMemoryProfileRepository);
    expect(await getProfileRepository()).toBe(first);
  });
});
