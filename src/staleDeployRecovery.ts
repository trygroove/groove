// Recovery for a tab left open across a deploy (GRV-137).
//
// Every build renames its hashed chunks and the old files are gone, so the
// first time an old tab lazy-loads code (opening a project imports
// `firestoreProjectRepository-*.js`) the import fails. Reloading fetches the
// new shell and its new chunks, and the user's next attempt works.
//
// Vite dispatches `vite:preloadError` when a chunk it preloads fails. A plain
// `import()` with no dependencies to preload is not wrapped, so it rejects
// with a bare TypeError whose message differs per browser; that is caught off
// `unhandledrejection`, but only when nothing handled the rejection first.
//
// One reload per `RELOAD_GUARD_WINDOW_MS`, remembered in sessionStorage: a
// chunk that is still missing after the reload (a genuine outage) must not
// loop. A window rather than a one-shot flag means a later deploy in the same
// tab recovers too.

export const RELOAD_GUARD_KEY = "groove_stale_deploy_reload_at";
export const RELOAD_GUARD_WINDOW_MS = 60_000;

/** Chromium, Firefox and Safari's wording of a failed dynamic import. */
const DYNAMIC_IMPORT_FAILURE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

export function isDynamicImportFailure(reason: unknown): boolean {
  return reason instanceof Error && DYNAMIC_IMPORT_FAILURE.test(reason.message);
}

export interface StaleDeployRecoveryOptions {
  target: EventTarget;
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
  reload: () => void;
}

/** Returns the function that removes the listeners. */
export function installStaleDeployRecovery(
  options: StaleDeployRecoveryOptions,
): () => void {
  const { target, storage, now, reload } = options;

  /** True when a reload was started; false when one just happened. */
  const recover = (): boolean => {
    const at = Number(storage.getItem(RELOAD_GUARD_KEY));
    const current = now();
    if (Number.isFinite(at) && at > 0 && current - at < RELOAD_GUARD_WINDOW_MS) {
      return false;
    }
    storage.setItem(RELOAD_GUARD_KEY, String(current));
    reload();
    return true;
  };

  const onPreloadError = (event: Event) => {
    if (recover()) event.preventDefault();
  };
  const onRejection = (event: Event) => {
    const reason = (event as Event & { reason?: unknown }).reason;
    if (isDynamicImportFailure(reason)) recover();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("vite:preloadError", onPreloadError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** The browser wiring: this window, this tab's sessionStorage. */
export function installStaleDeployRecoveryForWindow(): () => void {
  let storage: Storage;
  try {
    storage = window.sessionStorage;
  } catch {
    // Storage blocked: with no guard a reload could loop, so do not recover.
    return () => {};
  }
  return installStaleDeployRecovery({
    target: window,
    storage,
    now: () => Date.now(),
    reload: () => window.location.reload(),
  });
}
