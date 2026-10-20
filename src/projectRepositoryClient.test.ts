import { afterEach, describe, expect, it, vi } from "vitest";

// GRV-137: a failed chunk import must not be memoized for the life of the tab.
describe("getProjectRepository", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("./persistence/firestoreProjectRepository");
    vi.doUnmock("./devBackend");
    vi.doUnmock("./firebaseConfig");
  });

  it("tries the import again after it failed, instead of replaying the rejection", async () => {
    vi.doMock("./devBackend", () => ({ isMockBackend: false }));
    vi.doMock("./firebaseConfig", () => ({ db: {} }));
    let attempts = 0;
    vi.doMock("./persistence/firestoreProjectRepository", () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("Failed to fetch dynamically imported module: /assets/a.js");
      }
      return { FirestoreProjectRepository: class {} };
    });
    const { getProjectRepository } = await import("./projectRepositoryClient");

    await expect(getProjectRepository()).rejects.toThrow();
    await expect(getProjectRepository()).resolves.toBeDefined();
  });
});
