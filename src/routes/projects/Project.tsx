import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { type Accessor, createEffect, createSignal, Show } from "solid-js";
import { AuthProvider, useAuth } from "../../auth/AuthProvider";
import { authService } from "../../auth/authService";
import SignedInOnly from "../../auth/SignedInOnly";
import { detectCapabilities } from "../../browser/capabilities";
import AccountControl from "../../components/AccountControls";
import ProjectNotFound from "../../components/ProjectNotFound";
import EditorView from "../../editor/EditorView";
import { editorViewFromPath, editorViewPath } from "../../editor/editorViews";

/**
 * Whether the signed-in account is internal or an admin (GRV-112), so the
 * library does not hold it to the allowance the server no longer enforces for
 * it. Read from the ID token per account; an answer for an account that has
 * since signed out is dropped, and a token that cannot be read leaves the
 * account limited, which the server would hold it to anyway.
 */
function useUnlimitedAccount(): Accessor<boolean> {
  const auth = useAuth();
  const [unlimited, setUnlimited] = createSignal(false);
  createEffect(
    () => (auth.loading || auth.isAnonymous ? null : (auth.user?.uid ?? null)),
    (uid) => {
      setUnlimited(false);
      if (uid === null) return;
      let current = true;
      Promise.all([authService.isInternal(), authService.isAdmin()]).then(
        ([internal, admin]) => {
          if (current) setUnlimited(internal || admin);
        },
        () => {},
      );
      return () => {
        current = false;
      };
    },
  );
  return unlimited;
}

/**
 * The editor with the signed-in account handed in, so the library can offer
 * the producer their own packs (#282). Inside `AuthProvider`, which is what
 * `useAuth` reads.
 */
function AccountEditor(props: Parameters<typeof EditorView>[0]) {
  const auth = useAuth();
  const unlimited = useUnlimitedAccount();
  return (
    <EditorView
      {...props}
      libraryAccount={
        auth.user
          ? { uid: auth.user.uid, registered: !auth.isAnonymous, unlimited: unlimited() }
          : null
      }
      // A closed popup or a refused address leaves the session as it was,
      // and the assistant's prompt stays where it is.
      onSignIn={() => void auth.logIn().catch(() => {})}
    />
  );
}

export default function ProjectPage() {
  const params = useParams();
  // Three paths, one page module (`src/router.tsx`), so the view is read back
  // out of the address rather than held beside it (`UI-001`). That is what
  // makes a deep link, the back button and a reload all land on the same view.
  const location = useLocation();
  const navigate = useNavigate();
  // Probed once per visit to the editor, never by user-agent (PRD section 10).
  const capabilities = detectCapabilities();

  // Router 2 types `useParams()` as an open `Params` record, so `id` is
  // `string | undefined` even though this route only matches with one present.
  // `Show` is the honest narrowing: it reuses the not-found surface the editor
  // already shows for a project that cannot be opened, rather than asserting
  // the param away with `!` and leaving no answer for the case that "cannot
  // happen". The fallback is unreachable through the router; it is reachable
  // if the route table ever changes underneath this component.
  return (
    <AuthProvider>
      <SignedInOnly>
        <Show when={params.id} fallback={<ProjectNotFound />}>
          {(id) => (
            <AccountEditor
              projectId={id()}
              view={editorViewFromPath(location.pathname)}
              viewHref={(view) => editorViewPath(id(), view)}
              onSelectView={(view) => navigate(editorViewPath(id(), view))}
              account={<AccountControl class="account-button" />}
              capabilities={capabilities}
            />
          )}
        </Show>
      </SignedInOnly>
    </AuthProvider>
  );
}
