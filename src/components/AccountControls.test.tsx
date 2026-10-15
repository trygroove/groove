import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_ON_ALLOWLIST } from "../access/allowlist";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { AuthProvider } from "../auth/AuthProvider";
import { memoryStorage } from "../testing/storage";
import AccountControl from "./AccountControls";

// The editor header's account control (#951), with the real `AuthProvider` and
// only the Firebase boundary and the router doubled.

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

vi.mock("../auth/authService", () => ({ authService: fakeAuth.service }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigate }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderControl(user: unknown) {
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const reportError = vi.fn();
  render(() => (
    <AuthProvider analytics={analytics}>
      <AccountControl analytics={analytics} reportError={reportError} />
    </AuthProvider>
  ));
  if (user !== undefined) fakeAuth.emit(user);
  flush();
  return { transport, reportError };
}

describe("AccountControl (#951)", () => {
  it("shows nothing while the session is still resolving", () => {
    renderControl(undefined);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is Log in for a guest and Sign out for a signed-in user", () => {
    renderControl({ uid: "anon-1", isAnonymous: true });
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    fakeAuth.emit({ uid: "user-1", isAnonymous: false });
    flush();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
  });

  it("cancelling Log in signs nobody in", () => {
    renderControl({ uid: "anon-1", isAnonymous: true });

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    flush();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    flush();

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fakeAuth.service.signInWithGoogle).not.toHaveBeenCalled();
  });

  it("keeps the dialog up with a retry when Log in fails, and logs no use", async () => {
    fakeAuth.service.signInWithGoogle.mockRejectedValue(new Error("popup-closed"));
    const { transport, reportError } = renderControl({
      uid: "anon-1",
      isAnonymous: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    flush();
    fireEvent.click(screen.getByRole("button", { name: "Log in with Google" }));
    flush();

    expect(await screen.findByText(/Could not log in/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in with Google" })).toBeEnabled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      area: "shell",
      fatal: false,
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(transport.named("feature_first_use")).toHaveLength(0);
  });

  it("sends a guest whose account is not on the alpha list to the not-on-the-list page (#854)", async () => {
    fakeAuth.service.signInWithGoogle.mockRejectedValue(
      Object.assign(
        new Error(`BLOCKING_FUNCTION_ERROR_RESPONSE : ((${NOT_ON_ALLOWLIST}))`),
        {
          code: "auth/internal-error",
        },
      ),
    );
    const { transport, reportError } = renderControl({
      uid: "anon-1",
      isAnonymous: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    flush();
    fireEvent.click(screen.getByRole("button", { name: "Log in with Google" }));
    flush();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/not-invited"));
    expect(reportError).not.toHaveBeenCalled();
    expect(transport.named("sign_in_blocked")).toHaveLength(1);
    expect(transport.named("sign_in_blocked")[0].params).toMatchObject({
      source: "log_in",
    });
  });

  it("stays put and says so when Sign out fails", async () => {
    fakeAuth.service.signOut.mockRejectedValue(new Error("network"));
    const { transport } = renderControl({ uid: "user-1", isAnonymous: false });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    flush();

    expect(
      await screen.findByRole("button", { name: "Sign out failed, retry" }),
    ).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
    expect(transport.named("feature_first_use")).toHaveLength(0);
  });

  it("logs sign_out once per action", async () => {
    fakeAuth.service.signOut.mockImplementation(() => {
      fakeAuth.emit(null);
      return Promise.resolve();
    });
    const { transport } = renderControl({ uid: "user-1", isAnonymous: false });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    flush();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
    expect(
      transport
        .named("feature_first_use")
        .filter((event) => event.params?.feature === "sign_out"),
    ).toHaveLength(1);
  });
});
