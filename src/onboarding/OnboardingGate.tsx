import { useNavigate } from "@solidjs/router";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, type ParentProps, Show } from "solid-js";
import { useAuth } from "../auth/AuthProvider";
import type { ProfileRepository } from "../persistence/profileRepository";
import { getProfileRepository } from "../profileRepositoryClient";

/** Where a producer who has not been through onboarding is sent. */
export const WELCOME_PATH = "/welcome";

export interface OnboardingGateProps extends ParentProps {
  /** Drawn while the profile is read. */
  readonly fallback?: JSX.Element;
  readonly profiles?: () => Promise<ProfileRepository>;
}

/**
 * Draws its children for a producer who has completed or skipped onboarding,
 * and sends anyone else to the welcome (GRV-25), existing alpha accounts
 * included: an account with no profile, or one whose onboarding is still to
 * do. The redirect replaces the address, so Back does not bounce them here.
 *
 * A profile that cannot be read (offline, refused, a shape this build does
 * not know) lets them through: onboarding is never in the way of the work.
 */
export default function OnboardingGate(props: OnboardingGateProps): JSX.Element {
  const auth = useAuth();
  const navigate = useNavigate();
  const profiles = props.profiles ?? getProfileRepository;
  const [through, setThrough] = createSignal(false);

  // The uid is the one reactive read; the read and the navigation are the
  // apply half's.
  createEffect(
    () => auth.user?.uid ?? null,
    (uid) => {
      if (!uid) return;
      let cancelled = false;
      profiles()
        .then((repository) => repository.loadProfile(uid))
        .then(
          (result) => {
            if (cancelled) return;
            if (result.ok && !result.profile?.onboarding) {
              navigate(WELCOME_PATH, { replace: true });
              return;
            }
            setThrough(true);
          },
          () => {
            if (!cancelled) setThrough(true);
          },
        );
      return () => {
        cancelled = true;
      };
    },
  );

  return (
    <Show when={through()} fallback={props.fallback}>
      {props.children}
    </Show>
  );
}
