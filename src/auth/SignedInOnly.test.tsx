import { cleanup, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthProvider";
import SignedInOnly from "./SignedInOnly";

// The real `AuthProvider`, with only the Firebase boundary and the router doubled.
const fakeAuth = vi.hoisted(() => {
  let callback: ((user: unknown) => void) | null = null;
  return {
    emit(user: unknown) {
      callback?.(user);
    },
    service: {
      onAuthStateChanged: (cb: (user: unknown) => void) => {
        callback = cb;
        return () => {
          callback = null;
        };
      },
      signInWithGoogle: vi.fn(),
      signOut: vi.fn(),
      isInternal: vi.fn(() => Promise.resolve(false)),
    },
  };
});

vi.mock("./authService", () => ({ authService: fakeAuth.service }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigate }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderGuarded() {
  render(() => (
    <AuthProvider>
      <SignedInOnly fallback={<p>Restoring</p>}>
        <p>Your projects</p>
      </SignedInOnly>
    </AuthProvider>
  ));
}

describe("SignedInOnly (#854)", () => {
  it("shows the fallback, and goes nowhere, while the session is restoring", () => {
    renderGuarded();
    expect(screen.getByText("Restoring")).toBeInTheDocument();
    expect(screen.queryByText("Your projects")).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows a signed-in account its page", () => {
    renderGuarded();
    fakeAuth.emit({ uid: "user-1", isAnonymous: false });
    flush();
    expect(screen.getByText("Your projects")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("still shows a guest from before the alpha closed their page", () => {
    renderGuarded();
    fakeAuth.emit({ uid: "anon-1", isAnonymous: true });
    flush();
    expect(screen.getByText("Your projects")).toBeInTheDocument();
  });

  it("sends a visitor with no session to the landing page, and starts no guest", () => {
    renderGuarded();
    fakeAuth.emit(null);
    flush();
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(screen.queryByText("Your projects")).not.toBeInTheDocument();
    expect(fakeAuth.service.signInWithGoogle).not.toHaveBeenCalled();
    expect("signInAnonymously" in fakeAuth.service).toBe(false);
  });

  it("sends someone who signs out to the landing page too", () => {
    renderGuarded();
    fakeAuth.emit({ uid: "user-1", isAnonymous: false });
    flush();
    fakeAuth.emit(null);
    flush();
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(screen.queryByText("Your projects")).not.toBeInTheDocument();
  });
});
