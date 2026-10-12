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

  // The team's and the test accounts' sessions are internal traffic, so they
  // stay out of the product's measures without anyone typing `?internal=1`.
  describe("internal traffic", () => {
    it.each([
      "bpgodfrey@gmail.com",
      "groovetestuser1@gmail.com",
      "testuser0@qa.trygroove.app",
    ])("marks the browser internal when %s signs in, and persists it", async (email) => {
      const { fake, transport, internalTrafficStorage } = await renderAuthProvider();

      fake.emit({ uid: "user_team", email, isAnonymous: false });
      await settle();

      expect(transport.userProperties.internal).toBe("true");
      expect(transport.userProperties.account_type).toBe("registered");
      expect(internalTrafficStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBe("true");
    });

    it("leaves a cohort account's session as it was", async () => {
      const { fake, transport, internalTrafficStorage } = await renderAuthProvider();

      fake.emit({
        uid: "user_cohort",
        email: "producer@example.com",
        isAnonymous: false,
      });
      await settle();

      expect(transport.userProperties.internal).toBe("false");
      expect(internalTrafficStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBeNull();
    });

    it("keeps the browser marked after the internal account signs out", async () => {
      const { fake, transport, internalTrafficStorage } = await renderAuthProvider();

      fake.emit({ uid: "user_team", email: "bpgodfrey@gmail.com", isAnonymous: false });
      await settle();
      fake.emit(null);
      await settle();

      expect(transport.userProperties.internal).toBe("true");
      expect(internalTrafficStorage.getItem(INTERNAL_TRAFFIC_STORAGE_KEY)).toBe("true");
    });
  });
});
