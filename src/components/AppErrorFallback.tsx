import { Show } from "@solidjs/web";
import { type Component, createSignal, onSettled } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import type { CrashSaveOutcome } from "../analytics/catalog";
import type { ErrorArea } from "../analytics/errorCodes";
import { reportError } from "../monitoring/errorReporting";
import { flushPendingWrites } from "../shared/pendingWrites";
import "./AppErrorFallback.css";

type AppErrorFallbackProps = {
  error: unknown;
  reset: () => void;
  /** Which part of the app this boundary guards (PRD `OPS-03`). */
  area?: ErrorArea;
  /** Injectable so component tests assert reporting without a live boundary. */
  report?: typeof reportError;
  /** Writes queued edits before a reload (GRV-55); injectable for tests. */
  flushWrites?: () => Promise<CrashSaveOutcome>;
  /** Reloads the page; injectable for tests. */
  reload?: () => void;
  analytics?: Analytics;
};

/** Where the Reload button is: idle, writing queued edits, or refused by them. */
type ReloadState = "idle" | "saving" | "unsaved";

/**
 * Root-level fallback for the app's <Errored> boundary. Shown when a render-time
 * throw would otherwise leave the app blank. Offers a retry that clears the
 * boundary and re-renders its children.
 *
 * It is also one of the two capture points PRD `OPS-03` names — "global
 * `error`/`unhandledrejection` handlers plus the section 10 error boundaries".
 * Reporting happens in `onSettled` rather than during render so a failing
 * reporter cannot prevent the recovery UI from appearing, and it goes through
 * the application's own boundary rather than a monitoring SDK. Duplicate
 * reports (an error seen by both this boundary and the global handler) are
 * collapsed by fingerprint in `ErrorReporter`.
 *
 * The message shown to the *user* is the raw one — it is their own browser and
 * their own project. Only the message that gets *transmitted* is redacted, by
 * the reporting boundary.
 *
 * Reload (GRV-55) is the way out that always works: it writes any edit still
 * waiting to save first, then reloads. If the write cannot land (offline, say)
 * it says so and asks again rather than reloading the edit away, and offers
 * Reload anyway for a producer who would rather lose it.
 */
const AppErrorFallback: Component<AppErrorFallbackProps> = (props) => {
  const message = () =>
    props.error instanceof Error ? props.error.message : String(props.error);

  onSettled(() => {
    try {
      // Fatal: this boundary firing means a surface was replaced by a recovery
      // screen, which is what the section 11 crash-free session rate counts.
      (props.report ?? reportError)(props.error, {
        area: props.area ?? "shell",
        fatal: true,
      });
    } catch {
      // `reportError` already guarantees it cannot throw, so this only catches
      // an injected reporter or a future regression. It is kept because this
      // is the last screen before a blank page: an exception escaping here
      // would be thrown *from inside the error boundary's own fallback*,
      // which no boundary above can recover from.
    }
  });

  const [reloadState, setReloadState] = createSignal<ReloadState>("idle");
  function reloadNow(outcome: CrashSaveOutcome): void {
    (props.analytics ?? defaultAnalytics).log("crash_reloaded", {
      save_outcome: outcome,
    });
    (props.reload ?? (() => window.location.reload()))();
  }
  async function reload(): Promise<void> {
    if (reloadState() === "saving") return;
    setReloadState("saving");
    const outcome = await (props.flushWrites ?? flushPendingWrites)();
    if (outcome === "unsaved") {
      setReloadState("unsaved");
      return;
    }
    reloadNow(outcome);
  }

  return (
    <div class="app-error">
      <div class="app-error-copy">
        <p class="app-error-code">Error</p>
        <h1 class="app-error-title">Something went wrong</h1>
        <p class="app-error-message">{message()}</p>
        <output class="app-error-advice">
          {reloadState() === "unsaved"
            ? "Your latest changes couldn't be saved. Check your connection, then press Reload to try again."
            : "Reload to carry on. Any change still waiting to save is saved first."}
        </output>
        <div class="app-error-actions">
          <button
            type="button"
            class="app-error-reload"
            disabled={reloadState() === "saving"}
            onClick={() => void reload()}
          >
            {reloadState() === "saving" ? "Saving…" : "Reload"}
          </button>
          <Show
            when={reloadState() === "unsaved"}
            fallback={
              <button type="button" class="app-error-retry" onClick={() => props.reset()}>
                Try again
              </button>
            }
          >
            <button
              type="button"
              class="app-error-retry"
              onClick={() => reloadNow("unsaved")}
            >
              Reload anyway
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default AppErrorFallback;
