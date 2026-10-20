import { type JSX, Show } from "@solidjs/web";
import { type Component, createEffect, createSignal, onCleanup } from "solid-js";
import { ASSISTANT_NAME } from "../../site.config.mjs";
import { type ConsentState, type ConsentStore, consentStore } from "../analytics/consent";
import { type ShortcutHandlers, useShortcutScope } from "../shortcuts";
import "./TelemetryDisclosure.css";

/**
 * The user-facing disclosure and opt-out (PRD `OPS-02`, section 10 Security
 * and privacy).
 *
 * "The user is told what is collected and can decline product analytics
 * without losing any DAW or assistant capability." Turning this off stops
 * collection and changes nothing else — there is no capability behind it,
 * which `src/telemetry.test.ts` asserts by running the core journey (edit,
 * save, undo) with collection disabled and both transports throwing, and
 * comparing the result against the same journey with telemetry working.
 *
 * ## What this task does and does not decide
 *
 * `FND-001c` owns the mechanism: a persisted preference, an accessible
 * control, and a disclosure naming both processors. `DEC-009` owns the
 * *default state* (see `CONSENT_DEFAULT`) and the *final wording*. The copy
 * below is deliberately plain and factual so it is accurate as written, and it
 * is isolated here so settling `DEC-009` is a copy change in one file.
 *
 * `LOOP-001b` gives this surface its designed home in the landing page footer
 * (`placement="inline"`) per `DEC-009`. Everywhere else it floats as app chrome
 * (`placement="floating"`, the default), so the opt-out stays reachable from
 * the dashboard, the editor, and the error screen. `FloatingTelemetryDisclosure`
 * stands the floating copy down while an inline one is mounted, so a page never
 * carries two — which would also duplicate this component's element ids.
 */
const [inlineCount, setInlineCount] = createSignal(0);

/**
 * Whether a page is currently rendering its own inline copy of the disclosure.
 *
 * `FloatingTelemetryDisclosure` reads this to decide whether the app-chrome
 * copy is needed. Presence, not the route, is the thing that matters: the
 * landing page hosts its own, but only once its chunk has mounted and only
 * while it is rendering, so a route-based rule would leave `/` with no opt-out
 * on the error screen and while the page is still loading — exactly the
 * situations the floating copy exists for (PRD `OPS-02`).
 */
export const inlineDisclosureMounted = () => inlineCount() > 0;

/**
 * `view.close_surface` (Escape) for the open panel, mounted only while it is open.
 *
 * A modal dialog opened over the panel (the shortcuts guide, an export or a
 * confirmation) is the topmost surface, so its Escape is the dialog's alone and
 * the panel waits for the next one (GRV-148). Each of those registers a modal
 * shortcut scope, which hides this one while it is open (GRV-186), so the
 * panel needs to know nothing about them.
 */
function CloseOnEscape(props: { onClose(): void }): JSX.Element {
  useShortcutScope({
    handlers: (): ShortcutHandlers => ({
      "view.close_surface": { run: () => props.onClose() },
    }),
    contexts: () => [],
  });
  return null;
}

const TelemetryDisclosure: Component<{
  store?: ConsentStore;
  placement?: "floating" | "inline";
}> = (props) => {
  const store = props.store ?? consentStore;
  const [state, setState] = createSignal<ConsentState>(store.current);
  onCleanup(store.subscribe(setState));

  // Split effect: the compute half tracks the placement, the apply half does
  // the counting. That split is load-bearing rather than stylistic -- Solid 2
  // throws on a signal write inside a tracking scope, and the apply phase is
  // where a write is sanctioned. The decrement rides the returned cleanup for
  // the same reason a nested `onCleanup` no longer belongs here.
  createEffect(
    () => (props.placement ?? "floating") === "inline",
    (isInline) => {
      if (!isInline) return;
      setInlineCount((count) => count + 1);
      return () => setInlineCount((count) => count - 1);
    },
  );

  // Any collection at all shows as "on", so the single control never reads as
  // off while something is still being collected. `optOut()` turns all three
  // off in one action (ADR 0002 decision 4), which is the whole control the
  // user has; the flags stay separable for `DEC-009`, not for the UI.
  const enabled = () =>
    state().productAnalytics || state().errorMonitoring || state().sessionReplay;

  let details: HTMLDetailsElement | undefined;
  let summary: HTMLElement | undefined;
  const [open, setOpen] = createSignal(false);
  const close = () => {
    if (details) details.open = false;
    summary?.focus();
  };

  const toggle = () => {
    if (enabled()) {
      store.optOut();
    } else {
      store.optIn();
    }
  };

  return (
    <details
      ref={details}
      onToggle={() => setOpen(details?.open ?? false)}
      class={[
        "telemetry-disclosure",
        {
          "telemetry-disclosure-inline": (props.placement ?? "floating") === "inline",
        },
      ]}
    >
      <Show when={open()}>
        <CloseOnEscape onClose={close} />
      </Show>
      <summary ref={summary} class="telemetry-disclosure-summary">
        Privacy
      </summary>
      <div class="telemetry-disclosure-body">
        <p>
          Groove records which features are used and reports errors, so we can tell what
          works and fix what breaks. Two processors receive this: PostHog for product
          events, Session Replay and error reports, and Sentry for error reports.
        </p>
        <p>
          Session Replay records a small sample of sessions — which controls you click and
          how you move around — so we can see where people get stuck and fix it. Those
          recordings include your arrangement and piano roll, which means the musical work
          itself: the clips, the notes, and the names you give sections. We record them
          because that is where the problems we need to see actually happen.
        </p>
        <p>
          Names and typed text stay hidden. Event reports, error reports, and replays
          carry no project, track, or clip names, no audio, and no text you type. The one
          exception is your conversations with {ASSISTANT_NAME}, below.
        </p>
        <p>
          Unless you tell it not to in {ASSISTANT_NAME} settings, Groove keeps your
          conversations with {ASSISTANT_NAME} so we can tell whether it is helping. While
          it does, and only if you allow product analytics, each one — together with what
          is sent to Anthropic for it — also goes to PostHog, so we can see where{" "}
          {ASSISTANT_NAME} goes wrong. They are never sent to Sentry. Copies in PostHog
          are not deleted when Groove deletes its own: they expire under PostHog's data
          retention.
        </p>
        <label class="telemetry-disclosure-toggle">
          <input
            type="checkbox"
            checked={enabled()}
            onChange={toggle}
            aria-describedby="telemetry-disclosure-note"
          />
          <span>Share usage and error reports</span>
        </label>
        <p id="telemetry-disclosure-note" class="telemetry-disclosure-note">
          Turning this off stops collection. Every feature keeps working.
        </p>
      </div>
    </details>
  );
};

export default TelemetryDisclosure;
