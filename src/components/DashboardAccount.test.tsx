import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { AuthProvider } from "../auth/AuthProvider";
import { memoryStorage } from "../testing/storage";
import Dashboard from "./Dashboard";

// Issue #951: once someone is in the app, the dashboard must offer a guest a way
// to log in to an existing account and a signed-in user a way to sign out. The
// real `AuthProvider` and `Dashboard`, with only the Firebase boundary
// (`authService`), the router and the repository doubled.

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
      linkWithGoogle: vi.fn(),
      signOut: vi.fn(),
      isInternal: vi.fn(() => Promise.resolve(false)),
    },
  };
});

vi.mock("../auth/authService", () => ({ authService: fakeAuth.service }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigate }));

const listProjects = vi.hoisted(() => vi.fn());
vi.mock("../projectRepositoryClient", () => ({
  getProjectRepository: () =>
    Promise.resolve({ listProjects: (...args: unknown[]) => listProjects(...args) }),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const GUEST = { uid: "anon-1", isAnonymous: true };
const MEMBER = { uid: "user-1", isAnonymous: false };

function renderDashboardPage(user: unknown) {
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  listProjects.mockResolvedValue([]);
  render(() => (
    <AuthProvider analytics={analytics}>
      <Dashboard analytics={analytics} />
    </AuthProvider>
  ));
  fakeAuth.emit(user);
  flush();
  return { transport };
}

describe("Dashboard account controls (#951)", () => {
  it("offers a guest Log in, saying guest projects are not moved, and signs in rather than links", async () => {
    fakeAuth.service.signInWithGoogle.mockImplementation(() => {
      fakeAuth.emit(MEMBER);
      return Promise.resolve();
    });
    const { transport } = renderDashboardPage(GUEST);

    fireEvent.click(await screen.findByRole("button", { name: "Log in" }));
    flush();

    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(/projects you made here as a guest .* not moved/i),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Log in with Google" }));
    flush();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/projects"));
    expect(fakeAuth.service.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(fakeAuth.service.linkWithGoogle).not.toHaveBeenCalled();
    expect(transport.named("feature_first_use")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ feature: "log_in" }) }),
    ]);
  });

  it("does not offer a registered user Log in", async () => {
    renderDashboardPage(MEMBER);

    await screen.findByRole("button", { name: /New Project/ });
    expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
  });

  it("offers a signed-in user Sign out, which leaves for / without starting a new guest", async () => {
    fakeAuth.service.signOut.mockImplementation(() => {
      fakeAuth.emit(null);
      return Promise.resolve();
    });
    const { transport } = renderDashboardPage(MEMBER);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    flush();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
    expect(fakeAuth.service.signOut).toHaveBeenCalledTimes(1);
    expect(transport.named("feature_first_use")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ feature: "sign_out" }),
      }),
    ]);
  });

  it("points a failed Sign up with Google at a Log in control that is on the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeAuth.service.linkWithGoogle.mockRejectedValue(
      new Error("credential-already-in-use"),
    );
    renderDashboardPage(GUEST);

    fireEvent.click(await screen.findByRole("button", { name: /Sign up with Google/ }));
    flush();

    expect(await screen.findByText(/use Log in instead/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });
});
