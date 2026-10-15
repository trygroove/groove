// Telemetry wiring (PRD `OPS-02`, `OPS-03`, ADR 0001).
//
// One place where the analytics boundary, the error-reporting boundary, and
// their vendor transports are connected to the running application. The
// boundaries themselves know nothing about when the app painted, which route
// is showing, or whether Firebase is configured; that all lives here.
//
// ## Timing (PRD section 10 performance budgets)
//
// The dashboard and editor shells must be interactive within 3 seconds.
// Monitoring must not compete with that, so:
//
// - The Sentry SDK is dynamically imported **after first paint**, never as
//   part of the initial bundle. `scripts/verify-bundle-budget.mjs` fails the
//   build if it lands in an eagerly-loaded chunk.
// - It is **not loaded at all on the marketing landing page** (ADR 0001,
//   `LOOP-001b`), which has no editing state to protect and the strictest
//   first-impression budget.
// - The PostHog SDK is its own chunk too (ADR 0011, GRV-106), loaded when the
//   browser is idle after first paint, and never part of the prerendered
//   shell or the entry chunk. Unlike Sentry it **does** load on the landing
//   page (GRV-123), so a visitor who reads `/` and leaves is counted: its
//   `$pageview`, `landing_cta_click` and `$pageleave` are sent from there,
//   each event by beacon as it is logged rather than batched, because the
//   visitor may be about to leave.
//   On `/` it waits longer, until the page has loaded and settled
//   (`afterLandingSettled`), so it costs the landing page's LCP and TBT
//   nothing.
//   On `/` it is analytics only. Replay, web vitals, network timing and the
//   PostHog error sink start only once the session reaches an app surface
//   (`PostHogLoader.startAppCollection`, and the sinks with Sentry's).
//
// - **Errors go to two sinks** while PostHog's error tracking is evaluated
//   (ADR 0011 decision 3): Sentry's and PostHog's, attached to the reporting
//   boundary at the same moment so both see the same reports. PostHog's uses
//   the analytics client, so it adds no chunk of its own.
// - **Session replay is PostHog's** (ADR 0011 decision 2): the analytics
//   client records a sampled session whose replay consent allows it, and
//   Sentry records nothing.
//
// ## Consent governs collection, on every path
//
// Consent is not a single check at startup. It is re-consulted wherever
// collection could begin or resume, because all three of these happen after
// `initTelemetry` returns:
//
// - **The vendor SDK.** A declined session never loads PostHog at all, and
//   withdrawing consent at runtime calls its `opt_out_capturing()`
//   (`setVendorAnalyticsCollection`). Withdrawn before the SDK has loaded
//   (while it waits for the browser to go idle), the transport is disposed:
//   its queue is dropped and its load never runs. Until the user has made a choice, the
//   SDK keeps its identity in memory; once they have granted it, in
//   `localStorage` and a cookie.
// - **The surface.** Navigation off the landing page is client-side, so
//   `surfaceForPath(window.location.pathname)` at mount is not the surface the
//   session ends up on. Monitoring, the analytics SDK and `app_opened` are
//   driven by `setSurface`, which the router calls on every navigation.
// - **The direction of the toggle.** Withdrawal tears collection down and a
//   later grant rebuilds it. A one-way switch leaves a user who changes their
//   mind uncollected with the checkbox showing "on".

import { type Analytics, analytics } from "./analytics/analytics";
import type { Surface } from "./analytics/catalog";
import { type ConsentStore, consentStore } from "./analytics/consent";
import {
  createPostHogLoader,
  createPostHogTransport,
  type PostHogLoader,
  type PostHogPersistence,
  postHogSettings,
} from "./analytics/posthogTransport";
import { type AnalyticsTransport, noopTransport } from "./analytics/transport";
import {
  type ErrorReporter,
  type ErrorSink,
  errorReporter,
} from "./monitoring/errorReporting";
import { installGlobalErrorHandlers } from "./monitoring/globalHandlers";
import { PostHogErrorSink } from "./monitoring/posthogSink";
import { RELEASE_SHA } from "./release";

export interface InitTelemetryOptions {
  /** The surface the app load entered on. */
  surface: Surface;
  /** Overridden in tests so no test loads a vendor SDK. */
  createAnalyticsTransport?: () => AnalyticsTransport;
  /**
   * The PostHog client's owner. Defaults to one built from `VITE_POSTHOG_KEY`,
   * or none without a key, which leaves analytics on `noopTransport`. Tests
   * pass a fake to observe when the SDK would load.
   */
  postHogLoader?: PostHogLoader | null;
  /**
   * Applies a consent change to the vendor analytics SDK, if it is running:
   * `opt_out_capturing()` when withdrawn, and the persistence to use when
   * granted. Overridden in tests so no test loads PostHog.
   */
  setVendorAnalyticsCollection?: (
    enabled: boolean,
    persistence: PostHogPersistence,
  ) => void;
  /**
   * Stops the vendor's in-flight session recording when replay consent is
   * withdrawn. Overridden in tests so no test loads PostHog.
   */
  stopSessionReplay?: () => void;
  /**
   * Builds the PostHog error sink, attached beside Sentry's. Defaults to one
   * over the PostHog loader's client, or none without a PostHog key.
   */
  createPostHogErrorSink?: () => StoppableErrorSink | null;
  /**
   * Starts the error sink in place of the real dynamic import. May resolve to
   * a stopper, which lets a test observe that a sink started during a consent
   * withdrawal is stopped again.
   */
  startErrorSink?: StartErrorSink;
  /** Schedules work for after first paint. */
  afterPaint?: (task: () => void) => void;
  /**
   * Schedules the analytics SDK's load on the landing page: later than
   * `afterPaint`, once the page has loaded and settled (GRV-123). Returns a
   * canceller, which `dispose` calls.
   */
  afterLandingSettled?: (task: () => void) => () => void;
  reporter?: ErrorReporter;
  consent?: ConsentStore;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export interface Telemetry {
  /**
   * Records the surface the app is showing now, including after a client-side
   * navigation. Reaching a non-landing surface is what starts monitoring and
   * fires `app_opened`.
   */
  setSurface: (surface: Surface) => void;
  /**
   * Starts error monitoring if consent allows, a monitored surface has been
   * reached, and it is not already running or starting. Idempotent, so the
   * router and the consent subscription can both call it freely.
   */
  startMonitoringIfAllowed: () => void;
  /** Removes global handlers and stops vendor transports. */
  dispose: () => Promise<void>;
}

/** Detaches a started error sink and shuts its vendor transport down. */
export type StopErrorSink = () => Promise<void>;

/** A running sink's teardown handle. */
export interface RunningSink {
  stop: StopErrorSink;
}

/** An error sink that can be told to stop sending. */
export type StoppableErrorSink = ErrorSink & { stop?: () => void };

/**
 * A test's stand-in for the real dynamic import of the Sentry sink.
 *
 * May resolve to nothing or to a stopper.
 */
// biome-ignore-start lint/suspicious/noConfusingVoidType: `void` rather than
// `undefined` so an override can be written `async () => {}`, which most of
// them are — the "returns nothing" case is the common one here, and `undefined`
// would force every such override to return it explicitly.
export type StartErrorSink = (release: string) => Promise<void | StopErrorSink>;
// biome-ignore-end lint/suspicious/noConfusingVoidType: see above.

/**
 * Wires telemetry for one app load. Returns a disposer.
 *
 * Safe to call before anything else renders: nothing here awaits a network
 * request, and every failure path is swallowed.
 */
export function initTelemetry(options: InitTelemetryOptions): Telemetry {
  const consent = options.consent ?? consentStore;
  const reporter = options.reporter ?? errorReporter;
  const afterPaint = options.afterPaint ?? afterFirstPaint;

  /** Memory until the user has chosen; cookies once they have granted it. */
  const persistence = (): PostHogPersistence =>
    consent.preferenceExpressed ? "localStorage+cookie" : "memory";

  const postHog =
    options.postHogLoader !== undefined ? options.postHogLoader : defaultPostHogLoader();

  // The analytics SDK waits for this gate. On an app surface it opens after
  // first paint and an idle main thread. On the landing page (GRV-123) it
  // opens later still, once the page has loaded and settled
  // (`afterLandingSettled`), so parsing the SDK lands outside the window that
  // decides `/`'s LCP and TBT; if the visitor moves on into the app before
  // then, reaching the app surface opens it on the app's timing instead. It
  // is a gate rather than a call so the transport can be created (and queue)
  // from the first line, and so a transport rebuilt after a re-grant waits on
  // the same one.
  let openAnalyticsGate: () => void = () => {};
  const analyticsGate = new Promise<void>((resolve) => {
    openAnalyticsGate = resolve;
  });
  let analyticsGateScheduledForApp = false;
  /** The surface showing now: events logged on the landing page go at once. */
  let currentSurface = options.surface;
  let cancelLandingGate: () => void = () => {};
  if (postHog && options.surface === "landing") {
    cancelLandingGate = (options.afterLandingSettled ?? afterLandingSettled)(
      openAnalyticsGate,
    );
  }
  const createTransport =
    options.createAnalyticsTransport ??
    (() =>
      postHog
        ? createPostHogTransport({
            // Consent is read again when the gate opens, not only when the
            // transport was made: an opt-out on the landing page disposes this
            // transport (aborting the signal) long before the SDK would load.
            load: (signal) =>
              analyticsGate.then(() =>
                signal.aborted || !consent.analyticsAllowed
                  ? null
                  : postHog.load(persistence(), {
                      sessionReplayAllowed: () => consent.sessionReplayAllowed,
                    }),
              ),
            // A landing event is often the visitor's last, as when "Request an
            // invite" takes the tab to another site: it is sent as it is
            // logged rather than left in the batch for the unload to drain.
            sendAtOnce: () => currentSurface === "landing",
          })
        : noopTransport);
  const setVendorCollection =
    options.setVendorAnalyticsCollection ??
    ((enabled: boolean, mode: PostHogPersistence) =>
      postHog?.setCollection(enabled, mode));
  const stopSessionReplay =
    options.stopSessionReplay ?? (() => postHog?.stopSessionRecording());
  const createPostHogErrorSink =
    options.createPostHogErrorSink ??
    (() => (postHog ? new PostHogErrorSink(postHog.client) : null));

  analytics.refreshInternalTraffic();

  const uninstallHandlers = installGlobalErrorHandlers({
    reporter,
    target: options.target,
  });

  /** Whether a monitored (non-landing) surface has been reached this load. */
  let monitoredSurfaceReached = false;
  let appOpenedLogged = false;
  /** The running sink's teardown handles, or `null` when nothing is attached. */
  let sink: RunningSink | null = null;
  /** A start is scheduled or in flight, so `stopSink` is not yet meaningful. */
  let sinkStarting = false;
  let disposed = false;

  /**
   * Attaches the sinks, re-checking consent and disposal once Sentry's has
   * resolved.
   *
   * The start lands two animation frames plus an idle callback after it was
   * scheduled, and `TelemetryDisclosure` is reachable throughout. Neither the
   * consent subscription nor `dispose` can see a sink during that window —
   * `sink` is still null — so this is the only place that can stop one that
   * arrives too late. Without it, `sentry.init()` and its Release Health
   * session envelope stay attached for a user who has already declined or for
   * a page that has already torn telemetry down.
   *
   * The PostHog sink is attached in the same step as Sentry's, so the two see
   * the same reports from the same moment: the evaluation compares their
   * counts per release (ADR 0011 decision 3).
   */
  const attachSink = async (): Promise<void> => {
    try {
      const started = await startMonitoring(reporter, {
        override: options.startErrorSink,
      });
      if (disposed || !consent.errorMonitoringAllowed) {
        void started.stop();
        return;
      }
      sink = withPostHogSink(started);
    } finally {
      sinkStarting = false;
    }
  };

  /** Adds the PostHog sink beside a started Sentry one, under one teardown. */
  const withPostHogSink = (started: RunningSink): RunningSink => {
    let postHogSink: StoppableErrorSink | null = null;
    try {
      postHogSink = createPostHogErrorSink();
      if (postHogSink) reporter.addSink(postHogSink);
    } catch {
      // One sink failing to start never stops the other (ADR 0011).
      postHogSink = null;
    }
    if (!postHogSink) return started;
    const attached = postHogSink;
    return {
      stop: async () => {
        reporter.removeSink(attached);
        try {
          attached.stop?.();
        } catch {
          // Stopping is best-effort and must not surface.
        }
        await started.stop();
      },
    };
  };

  const startMonitoringIfAllowed = (): void => {
    if (disposed || !monitoredSurfaceReached) return;
    if (sink !== null || sinkStarting) return;
    if (!consent.errorMonitoringAllowed) return;
    sinkStarting = true;
    afterPaint(() => {
      if (disposed || !consent.errorMonitoringAllowed) {
        sinkStarting = false;
        return;
      }
      void attachSink();
    });
  };

  const setSurface = (surface: Surface): void => {
    // After `dispose` the wiring is gone; a late navigation must not resurrect
    // `app_opened` or a monitoring start the disposer has no handle on.
    if (disposed) return;
    currentSurface = surface;
    analytics.setSurface(surface);
    // ADR 0001: the marketing landing page loads no monitoring SDK, and
    // `app_opened` is not its event — `landing_cta_click` is. The analytics
    // SDK loads there too, but collects analytics only (GRV-123).
    if (surface === "landing") return;
    monitoredSurfaceReached = true;
    if (postHog && !analyticsGateScheduledForApp) {
      analyticsGateScheduledForApp = true;
      afterPaint(openAnalyticsGate);
    }
    try {
      postHog?.startAppCollection();
    } catch {
      // Telemetry never throws into navigation.
    }
    if (!appOpenedLogged) {
      // PRD `OPS-02`: `app_opened` fires when "the editor or dashboard shell
      // becomes interactive". That is reaching a non-landing surface, whether
      // the session deep-linked into it or was client-navigated there. Once
      // per app load rather than per navigation: page views are counted by
      // the router's `pageview()`, and PostHog derives sessions itself.
      appOpenedLogged = true;
      analytics.log("app_opened");
    }
    startMonitoringIfAllowed();
  };

  /** Whether the vendor transport is the one attached to the boundary. */
  let analyticsWired = false;

  // Delivered synchronously on subscribe, which is what wires the initial
  // state, and again on every change. Symmetric in both directions: a grant
  // rebuilds exactly what a withdrawal tore down.
  const unsubscribeConsent = consent.subscribe((state) => {
    // ADR 0002 decision 4: withdrawing replay stops the in-flight recording
    // rather than merely dropping it before send, and analytics keeps running.
    // Done *first*, and on the replay flag alone, so it happens whether replay
    // alone was withdrawn or the single control turned everything off. A
    // replay declined before the SDK loads is honoured at the source instead:
    // the loader reads the same flag before it starts a recording.
    //
    // A later re-grant does not resume recording in this page load; it takes
    // effect on the next. That is the safe direction to be asymmetric in.
    if (!state.sessionReplay) {
      try {
        stopSessionReplay();
      } catch {
        // Consent changes never throw into the app.
      }
    }

    if (state.errorMonitoring) {
      startMonitoringIfAllowed();
    } else if (sink) {
      const running = sink;
      sink = null;
      void running.stop();
    }

    if (state.productAnalytics) {
      setVendorCollection(true, persistence());
      // Only a change *to* allowed builds a transport: another flag changing
      // (replay alone, say) must not replace one whose queue is still waiting
      // for the SDK, because replacing it drops that queue.
      if (!analyticsWired) {
        // The transport is swapped in synchronously; it buffers internally
        // until the vendor SDK resolves, so `app_opened` is not lost to lazy
        // loading.
        try {
          analytics.setTransport(createTransport());
          analyticsWired = true;
        } catch {
          // Leaves the previous transport in place. Analytics fails open.
        }
      }
    } else {
      // The boundary already refuses to send while consent is withdrawn;
      // replacing the transport disposes it as well, which drops what it had
      // buffered and cancels its pending SDK load, and opting the SDK out
      // stops a client that is already running.
      analyticsWired = false;
      analytics.setTransport(noopTransport);
      setVendorCollection(false, persistence());
    }
  });

  // Last, so the transport above is already attached when `app_opened` fires.
  setSurface(options.surface);

  return {
    setSurface,
    startMonitoringIfAllowed,
    dispose: async () => {
      disposed = true;
      cancelLandingGate();
      unsubscribeConsent();
      uninstallHandlers();
      const running = sink;
      sink = null;
      if (running) await running.stop();
    },
  };
}

function defaultPostHogLoader(): PostHogLoader | null {
  const settings = postHogSettings();
  return settings ? createPostHogLoader({ settings }) : null;
}

/**
 * Why monitoring is not running, recorded on the page for diagnosis.
 *
 * `FND-001c` (#174): the three ways this can fail — no DSN, a vendor import
 * that never resolves, an `init()` that throws — all failed *silently and
 * identically*, so a deployed build that was not reporting errors could not be
 * told apart from one that had nothing to report. That indistinguishability is
 * what made the original defect take a full investigation to place.
 *
 * It must still fail *open*: a blocked SDK is an expected, correct outcome for
 * some sessions (ADR 0001), so this records a status rather than surfacing
 * anything to the user or reporting anywhere. It carries no user data — only
 * which branch was taken.
 */
type MonitoringStatus = "started" | "no-dsn" | "load-failed";

function recordMonitoringStatus(status: MonitoringStatus): void {
  try {
    (globalThis as { __sgMonitoring?: MonitoringStatus }).__sgMonitoring = status;
  } catch {
    // Diagnosis is best-effort and must never be the thing that breaks startup.
  }
}

/**
 * Loads the Sentry sink and attaches it to the reporting boundary.
 *
 * The dynamic `import()` is what keeps the SDK out of the entry chunk, so it
 * must stay inside this function rather than moving to a top-level import.
 */
async function startMonitoring(
  reporter: ErrorReporter,
  config: { override?: StartErrorSink },
): Promise<RunningSink> {
  const inert: RunningSink = { stop: async () => {} };
  if (config.override) {
    const result = await config.override(RELEASE_SHA).catch(() => undefined);
    return typeof result === "function" ? { stop: result } : inert;
  }
  try {
    const { SentrySink } = await import("./monitoring/sentrySink");
    const sink = new SentrySink({ release: RELEASE_SHA });
    const started = await sink.start();
    if (!started) {
      // `SentrySink.start()` resolves false only when no DSN is configured;
      // every other failure throws and lands in the catch below.
      recordMonitoringStatus("no-dsn");
      return inert;
    }
    reporter.addSink(sink);
    recordMonitoringStatus("started");
    return {
      stop: async () => {
        reporter.removeSink(sink);
        await sink.stop();
      },
    };
  } catch {
    // A blocked or failed SDK load is expected for some sessions (ADR 0001:
    // "Ad and tracker blockers block sentry.io"). Errors still reach the
    // analytics `exception` counter, and the resulting undercount is documented.
    recordMonitoringStatus("load-failed");
    return inert;
  }
}

/**
 * Runs a task once the browser has painted and gone idle.
 *
 * Two nested `requestAnimationFrame` callbacks land after the first paint has
 * been committed; `requestIdleCallback` then waits for the main thread to be
 * free, with a timeout so a permanently busy thread does not starve it.
 *
 * ## A tab that never paints must still get there (`FND-001c`, #174)
 *
 * `requestAnimationFrame` does not fire while a document is hidden, and a tab
 * can start that way and stay that way indefinitely — a restored window, a
 * middle-clicked link, a deep link opened behind the current page. Waiting on
 * a frame alone meant such a session loaded no monitoring SDK *at all*: the
 * sink chunk was never even fetched, so a crash in front of a real user went
 * unreported, and the whole thing looked like a configuration failure from
 * outside because every documented gate had passed.
 *
 * So the frame path is *raced* against an idle deadline rather than trusted as
 * the only route. Whichever arrives first wins and the other is ignored; on a
 * visible tab that is still the frame path, so the "after first paint" budget
 * (PRD section 10) is unchanged for the sessions it was written for.
 */
export function afterFirstPaint(task: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    try {
      task();
    } catch {
      // Telemetry startup must never break the app that just painted.
    }
  };

  const idle = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;

  /** Waits for a free main thread, but never longer than the timeout. */
  const whenIdle = () => {
    if (typeof idle === "function") {
      idle(run, { timeout: 3_000 });
    } else {
      setTimeout(run, 0);
    }
  };

  if (typeof requestAnimationFrame !== "function") {
    setTimeout(run, 0);
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(whenIdle);
  });

  // The backstop for a document that is hidden now or becomes hidden before
  // the second frame lands. Deliberately not a `visibilitychange` listener:
  // the tab may never be foregrounded, and monitoring that only starts if the
  // user happens to look at the page is not monitoring.
  whenIdle();
}

/**
 * How long the landing page waits after its `load` event before it loads the
 * analytics SDK (GRV-123). Long enough that the SDK's download and parse fall
 * outside the window lab tools measure `/`'s LCP and TBT in; short enough
 * that most visits, bounces included, still last until it loads.
 */
export const LANDING_ANALYTICS_DELAY_MS = 3_000;

/**
 * Runs a task once the landing page has loaded and settled: after the window
 * `load` event, then `LANDING_ANALYTICS_DELAY_MS`, then `afterFirstPaint`'s
 * frame and idle wait. Nothing the page needs to render or respond is still
 * in flight by then, so the analytics SDK competes with none of it.
 *
 * Returns a canceller: the load listener and the delay are cleared, and a
 * task already handed to `afterFirstPaint` does not run.
 */
export function afterLandingSettled(
  task: () => void,
  delayMs: number = LANDING_ANALYTICS_DELAY_MS,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (!cancelled) task();
  };
  const settle = () => {
    if (cancelled) return;
    timer = setTimeout(() => afterFirstPaint(run), delayMs);
  };
  let listening = false;
  try {
    if (typeof document === "undefined" || document.readyState === "complete") {
      settle();
    } else {
      window.addEventListener("load", settle, { once: true });
      listening = true;
    }
  } catch {
    settle();
  }
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (listening) {
      try {
        window.removeEventListener("load", settle);
      } catch {
        // Nothing left to cancel.
      }
    }
  };
}

/**
 * What the router does on each location: hands the surface to telemetry, and
 * sends one page view per new pathname (the vendor's own pageview capture is
 * off, GRV-106). `SurfaceTracker` in `src/app.tsx` calls it from an effect.
 *
 * Until `initTelemetry` has run there is no telemetry and no transport, so the
 * surface goes to the analytics boundary directly and no page view is sent;
 * the call that follows with telemetry sends the entry page's view then, so
 * it is not lost to mount order. A repeat of the same pathname (a query or
 * hash change, or the effect re-running) sends nothing.
 */
export function createRouteTracker(
  boundary: Pick<Analytics, "setSurface" | "pageview"> = analytics,
): (pathname: string, telemetry: Pick<Telemetry, "setSurface"> | null) => void {
  /** The path the last page view was sent for, so each navigation counts once. */
  let pageviewSentFor: string | null = null;
  return (pathname, telemetry) => {
    const surface = surfaceForPath(pathname);
    if (!telemetry) {
      boundary.setSurface(surface);
      return;
    }
    telemetry.setSurface(surface);
    if (pathname === pageviewSentFor) return;
    pageviewSentFor = pathname;
    boundary.pageview();
  };
}

/** Maps a pathname onto the surface it belongs to. */
export function surfaceForPath(pathname: string): Surface {
  if (/^\/projects\/[^/]/.test(pathname)) return "editor";
  if (pathname === "/" || pathname === "") return "landing";
  return "dashboard";
}
