import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { INTERNAL_TRAFFIC_STORAGE_KEY } from "../shared/internalTraffic";
import { memoryStorage } from "../testing/storage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

type AuthCallback = (user: unknown) => void;

/** A controllable `authService` double: the test decides when it "resolves". */
function createFakeAuthService() {
  let callback: AuthCallback | null = null;
  return {
    service: {
      onAuthStateChanged: vi.fn((cb: AuthCallback) => {
        callback = cb;
        return () => {
          callback = null;
        };
      }),
      signInWithGoogle: vi.fn(() => Promise.resolve()),
      linkWithGoogle: vi.fn(() => Promise.resolve()),
      signOut: vi.fn(() => Promise.resolve()),
      getCurrentUser: vi.fn(() => null),
      /** The `internal` claim of whoever is signed in; no account has it by default. */
      isInternal: vi.fn(() => Promise.resolve(false)),
    },
    emit(user: unknown) {
      callback?.(user);
    },
  };
}

async function renderAuthProvider() {
  const fake = createFakeAuthService();
  vi.doMock("./authService", () => ({ authService: fake.service }));

  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });

  const internalTrafficStorage = memoryStorage();
  const { AuthProvider } = await import("./AuthProvider");
  render(() => (
    <AuthProvider analytics={analytics} internalTrafficStorage={internalTrafficStorage}>
      <div>child</div>
    </AuthProvider>
  ));

  return { fake, transport, internalTrafficStorage };
}

/** Lets the auth store's effects run after `emit`. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AuthProvider", () => {
  // #854: guest start is retired. No session means signed out, and nothing
  // is minted in its place.
  it("leaves a visitor with no session signed out, and starts no guest", async () => {
    const { fake, transport } = await renderAuthProvider();

    fake.emit(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.service.signInWithGoogle).not.toHaveBeenCalled();
    expect("signInAnonymously" in fake.service).toBe(false);
    expect(transport.named("anon_session_created")).toHaveLength(0);
  });

  it("restores a guest session from before the alpha closed, as it is", async () => {
    const { fake, transport } = await renderAuthProvider();

    fake.emit({ uid: "user_returning", isAnonymous: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.service.signInWithGoogle).not.toHaveBeenCalled();
    expect(transport.named("anon_session_created")).toHaveLength(0);
  });

  // GRV-106: analytics identifies the account by its Firebase UID alone, and
  // forgets it on sign-out.
  describe("analytics identity", () => {
    it("identifies a signed-in account by its UID and nothing else", async () => {
      const { fake, transport } = await renderAuthProvider();

      fake.emit({
        uid: "user_123",
        email: "producer@example.com",
        displayName: "A Producer",
        isAnonymous: false,
      });
      await settle();

      expect(transport.userId).toBe("user_123");
      const sent = JSON.stringify(transport.userProperties);
      expect(sent).not.toContain("producer@example.com");
      expect(sent).not.toContain("A Producer");
    });

    it("resets the identity on sign-out", async () => {
      const { fake, transport } = await renderAuthProvider();

      fake.emit({ uid: "user_123", email: "producer@example.com", isAnonymous: false });
      await settle();
      fake.emit(null);
      await settle();

      expect(transport.userId).toBeNull();
      expect(transport.identityResets).toBe(1);
    });

    it("resets nothing for a page that loads signed out", async () => {
      const { fake, transport } = await renderAuthProvider();

      fake.emit(null);
      await settle();

      expect(transport.userId).toBeNull();
      expect(transport.identityResets).toBe(0);
    });
  });

  // GRV-113: an account's sessions are internal traffic when its ID token
  // carries the `internal` claim, so they stay out of the product's measures
  // without anyone typing `?internal=1`. The address plays no part.
  describe("internal traffic", () => {
    it("marks the browser internal when a flagged account signs in, and persists it", async () => {
      const { fake, transport, internalTrafficStorage } = await renderAuthProvider();
      fake.service.isInternal.mockResolvedValue(true);

      fake.emit({ uid: "user_team", email: "team@example.com", isAnonymous: false });
      await settle();
      await settle();

      expect(fake.service.isInternal).toHaveBeenCalledTimes(1);
      expect(transport.userProperties.internal).toBe("true");
      expect(transport.userProperties.account_type).toBe("registered");
      expect(internalTrafficStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBe("true");
    });

    it("leaves an unflagged account's session as it was", async () => {
      const { fake, transport, internalTrafficStorage } = await renderAuthProvider();

      fake.emit({
        uid: "user_cohort",
        email: "producer@example.com",
        isAnonymous: false,
      });
      await settle();
      await settle();

      expect(fake.service.isInternal).toHaveBeenCalledTimes(1);
      expect(transport.userProperties.internal).toBe("false");
      expect(internalTrafficStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBeNull();
    });

    it("asks nothing for a visitor who is signed out or a guest", async () => {
      const { fake } = await renderAuthProvider();

      fake.emit(null);
      await settle();
      fake.emit({ uid: "user_guest", isAnonymous: true });
      await settle();

      expect(fake.service.isInternal).not.toHaveBeenCalled();
    });

    it("keeps the browser marked after the internal account signs out", async () => {
      const { fake, transport, internalTrafficStorage } = await renderAuthProvider();
      fake.service.isInternal.mockResolvedValue(true);

      fake.emit({ uid: "user_team", email: "team@example.com", isAnonymous: false });
      await settle();
      await settle();
      fake.emit(null);
      await settle();

      expect(transport.userProperties.internal).toBe("true");
      expect(internalTrafficStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBe("true");
    });

    it("drops a claim that arrives after the session has changed", async () => {
      const { fake, transport, internalTrafficStorage } = await renderAuthProvider();
      let answer: (internal: boolean) => void = () => {};
      fake.service.isInternal.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
      );

      fake.emit({ uid: "user_team", email: "team@example.com", isAnonymous: false });
      await settle();
      fake.emit({
        uid: "user_cohort",
        email: "producer@example.com",
        isAnonymous: false,
      });
      await settle();
      answer(true);
      await settle();
      await settle();

      expect(transport.userProperties.internal).toBe("false");
      expect(internalTrafficStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBeNull();
    });

    it("marks nothing, and throws nothing, when the token cannot be read", async () => {
      const { fake, transport, internalTrafficStorage } = await renderAuthProvider();
      fake.service.isInternal.mockRejectedValue(new Error("network"));

      fake.emit({ uid: "user_team", email: "team@example.com", isAnonymous: false });
      await settle();
      await settle();

      expect(transport.userProperties.internal).toBe("false");
      expect(internalTrafficStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBeNull();
    });
  });
});
