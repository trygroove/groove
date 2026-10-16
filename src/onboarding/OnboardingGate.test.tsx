import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryProfileRepository } from "../persistence/inMemoryProfileRepository";
import { emptyProfile } from "../persistence/profileDocuments";
import type { ProfileRepository } from "../persistence/profileRepository";
import OnboardingGate, { WELCOME_PATH } from "./OnboardingGate";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { uid: "user-1" }, loading: false, isAnonymous: false }),
}));

const navigate = vi.fn();
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigate }));

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

function renderGate(profiles: ProfileRepository) {
  render(() => (
    <OnboardingGate profiles={() => Promise.resolve(profiles)} fallback={<p>Loading</p>}>
      <p>The dashboard</p>
    </OnboardingGate>
  ));
}

describe("OnboardingGate (GRV-25)", () => {
  it("sends an account with no profile to the welcome", async () => {
    renderGate(new InMemoryProfileRepository());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(WELCOME_PATH, { replace: true }),
    );
    expect(screen.queryByText("The dashboard")).not.toBeInTheDocument();
  });

  it("lets through someone who completed or skipped onboarding", async () => {
    for (const onboarding of ["completed", "skipped"] as const) {
      const profiles = new InMemoryProfileRepository();
      await profiles.saveProfile("user-1", { ...emptyProfile(1), onboarding });
      renderGate(profiles);
      expect(await screen.findByText("The dashboard")).toBeInTheDocument();
      cleanup();
    }
    expect(navigate).not.toHaveBeenCalled();
  });

  it("lets them through when the profile cannot be read", async () => {
    const failing: ProfileRepository = {
      loadProfile: async () => ({
        ok: false,
        reason: "unavailable",
        message: "offline",
        retryable: true,
      }),
      saveProfile: async () => {
        throw new Error("unused");
      },
    };
    renderGate(failing);
    expect(await screen.findByText("The dashboard")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
