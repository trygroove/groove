import { cleanup, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../auth/AuthProvider";
import AdminGate from "./AdminGate";

// The real `AuthProvider`, with only the Firebase boundary doubled.
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
      isAdmin: vi.fn(),
    },
  };
});

vi.mock("../../auth/authService", () => ({ authService: fakeAuth.service }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderGate(isAdmin: () => Promise<boolean>) {
  render(() => (
    <AuthProvider>
      <AdminGate isAdmin={isAdmin}>
        <p>Admin only</p>
      </AdminGate>
    </AuthProvider>
  ));
}

describe("AdminGate (#854)", () => {
  it("shows the page to an account with the admin claim", async () => {
    renderGate(async () => true);
    fakeAuth.emit({ uid: "admin-1", isAnonymous: false });
    flush();
    expect(await screen.findByText("Admin only")).toBeInTheDocument();
  });

  it("shows anyone else the 404 page, and never the admin content", async () => {
    renderGate(async () => false);
    fakeAuth.emit({ uid: "user-1", isAnonymous: false });
    flush();
    expect(await screen.findByText("This page doesn't exist")).toBeInTheDocument();
    expect(screen.queryByText("Admin only")).not.toBeInTheDocument();
  });

  it("treats a claim it cannot read as no claim", async () => {
    renderGate(async () => {
      throw new Error("token refresh failed");
    });
    fakeAuth.emit({ uid: "user-1", isAnonymous: false });
    flush();
    expect(await screen.findByText("This page doesn't exist")).toBeInTheDocument();
  });

  it("shows nothing of the page while the session is still resolving", () => {
    renderGate(async () => true);
    expect(screen.queryByText("Admin only")).not.toBeInTheDocument();
    expect(screen.queryByText("This page doesn't exist")).not.toBeInTheDocument();
  });
});
