import { afterEach, describe, expect, it, vi } from "vitest";

// Force the mock backend so createAuthService() returns MockAuthService
// without touching Firebase.
vi.stubEnv("VITE_DEV_BACKEND", "mock");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MockAuthService (#854)", () => {
  it("starts signed in as the invited Google account, never as a guest", async () => {
    const { createAuthService } = await import("./authService");
    const authService = createAuthService();
    expect(authService.getCurrentUser()).toMatchObject({
      uid: "mock-user-123",
      isAnonymous: false,
    });
    expect(await authService.isAdmin()).toBe(true);
    expect(await authService.isInternal()).toBe(false);
    expect("signInAnonymously" in authService).toBe(false);
  });

  it("is signed out after signing out, until the next page load", async () => {
    const { createAuthService } = await import("./authService");
    const authService = createAuthService();
    await authService.signOut();
    expect(authService.getCurrentUser()).toBeNull();
    expect(await authService.isAdmin()).toBe(false);
  });
});

describe("MockAuthService.onAuthStateChanged", () => {
  it("invokes a newly-registered observer with the current user", async () => {
    const { createAuthService } = await import("./authService");
    const authService = createAuthService();

    const seen: unknown[] = [];
    authService.onAuthStateChanged((user) => seen.push(user));

    // The mock reports current state asynchronously (matching Firebase's
    // real contract), so it hasn't arrived yet synchronously...
    expect(seen).toHaveLength(0);

    // ...but does arrive once the microtask queue drains.
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ uid: "mock-user-123", isAnonymous: false });
  });

  it("notifies observers registered before a sign-in when it happens", async () => {
    const { createAuthService } = await import("./authService");
    const authService = createAuthService();
    await authService.signOut();

    const seen: unknown[] = [];
    const unsubscribe = authService.onAuthStateChanged((user) => seen.push(user));

    // Let the initial "current state" (null) delivery land first, exactly
    // as a real subscriber (e.g. AuthProvider's effect) would experience
    // on mount, before the user does anything.
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([null]);

    await authService.signInWithGoogle();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ uid: "mock-user-123", isAnonymous: false });

    unsubscribe();
  });

  it("does not deliver a stale notification to an observer that unsubscribed", async () => {
    const { createAuthService } = await import("./authService");
    const authService = createAuthService();

    const seen: unknown[] = [];
    const unsubscribe = authService.onAuthStateChanged((user) => seen.push(user));

    // Unsubscribe immediately, before the deferred "current state"
    // delivery has a chance to run.
    unsubscribe();

    await authService.signInWithGoogle();
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(0);
  });

  it("does not double-notify when a sign-in races the initial state delivery", async () => {
    const { createAuthService } = await import("./authService");
    const authService = createAuthService();
    await authService.signOut();

    // Subscribe and, in the same synchronous task, trigger a sign-in -
    // mirroring a click handler that runs `await signInWithGoogle()`
    // right after a component mounts and subscribes.
    const seen: unknown[] = [];
    authService.onAuthStateChanged((user) => seen.push(user));
    await authService.signInWithGoogle();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Only one notification for the signed-in user - not one from the
    // synchronous sign-in and a redundant duplicate from the deferred
    // initial-state delivery.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ uid: "mock-user-123", isAnonymous: false });
  });
});
