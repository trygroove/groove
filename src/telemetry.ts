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
// - The PostHog SDK follows the same rules (ADR 0011, GRV-106): its own
//   chunk, loaded after first paint and never on the landing page. Analytics
//   is still *wired* there, because `landing_cta_click` is measured there:
//   the transport queues it, and it is sent once the visitor reaches a
//   surface that loads the SDK (sign-in is a popup, so the queue survives it).
//
// ## Consent governs collection, on every path
//
// Consent is not a single check at startup. It is re-consulted wherever
// collection could begin or resume, because all three of these happen after
// `initTelemetry` returns:
//
// - **The vendor SDK.** A declined session never loads PostHog at all, and
//   withdrawing consent at runtime calls its `opt_out_capturing()`
//   (`setVendorAnalyticsCollection`). Until the user has made a choice, the
//   SDK keeps its identity in memory; once they have granted it, in
//   `localStorage` and a cookie.
// - **The surface.** Navigation off the landing page is client-side, so
//   `surfaceForPath(window.location.pathname)` at mount is not the surface the
//   session ends up on. Monitoring, the analytics SDK and `app_opened` are
//   driven by `setSurface`, which the router calls on every navigation.
// - **The direction of the toggle.** Withdrawal tears collection down and a
//   later grant rebuilds it. A one-way switch leaves a user who changes their
//   mind uncollected with the checkbox showing "on".

import { analytics } from "./analytics/analytics";
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
import { type ErrorReporter, errorReporter } from "./monitoring/errorReporting";
import { installGlobalErrorHandlers } from "./monitoring/globalHandlers";
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
   * Starts the error sink in place of the real dynamic import. May resolve to
   * a stopper, which lets a test observe that a sink started during a consent
   * withdrawal is stopped again.
   */
  startErrorSink?: StartErrorSink;
  /** Schedules work for after first paint. */
  afterPaint?: (task: () => void) => void;
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

/**
 * A running sink's teardown handles.
 *
 * `stopReplay` is separate from `stop` because the two consents are separate:
 * withdrawing replay alone must stop the in-flight recording (ADR 0002
 * decision 4) while error monitoring keeps running, so tearing the whole sink
 * down is the wrong action for it.
 */
export interface RunningSink {
  stop: StopErrorSink;
  stopReplay: () => Promise<void>;
}

/**
 * A test's stand-in for the real dynamic import.
 *
 * May resolve to nothing, to a bare stopper, or to a whole `RunningSink` — the
 * last of which is what lets a test observe the replay stop *separately* from
 * the sink teardown, which is the distinction ADR 0002 decision 4 turns on.
 */
// biome-ignore-start lint/suspicious/noConfusingVoidType: `void` rather than
// `undefined` so an override can be written `async () => {}`, which most of
// them are — the "returns nothing" case is the common one here, and `undefined`
// would force every such override to return it explicitly.
export type StartErrorSink = (
  release: string,
  options: { sessionReplay: boolean },
) => Promise<void | StopErrorSink | RunningSink>;
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

  // The analytics SDK waits for this: a non-landing surface, painted. It is a
  // gate rather than a call so the transport can be created (and queue) from
  // the first line, on the landing page included.
  let openAnalyticsGate: () => void = () => {};
  const analyticsGate = new Promise<void>((resolve) => {
    let opened = false;
    openAnalyticsGate = () => {
      if (opened || !postHog) return;
      opened = true;
      afterPaint(resolve);
    };
  });
  const createTransport =
    options.createAnalyticsTransport ??
    (() =>
      postHog
        ? createPostHogTransport({
            load: () => analyticsGate.then(() => postHog.load(persistence())),
          })
        : noopTransport);
  const setVendorCollection =
    options.setVendorAnalyticsCollection ??
    ((enabled: boolean, mode: PostHogPersistence) =>
      postHog?.setCollection(enabled, mode));

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
   * Attaches the sink, re-checking consent and disposal once it has resolved.
   *
   * The start lands two animation frames plus an idle callback after it was
   * scheduled, and `TelemetryDisclosure` is reachable throughout. Neither the
   * consent subscription nor `dispose` can see a sink during that window —
   * `sink` is still null — so this is the only place that can stop one that
   * arrives too late. Without it, `sentry.init()` and its Release Health
   * session envelope stay attached for a user who has already declined or for
   * a page that has already torn telemetry down.
   *
   * Replay consent is read here rather than at schedule time, because it is
   * the value the SDK is *constructed* with (ADR 0002 decision 4) and the user
   * can change it anywhere in that window. Withdrawing it after the sink
   * resolves is handled by the consent subscription below, which stops the
   * in-flight recording.
   */
  const attachSink = async (): Promise<void> => {
    try {
      const started = await startMonitoring(reporter, {
        sessionReplay: consent.sessionReplayAllowed,
        override: options.startErrorSink,
      });
      if (disposed || !consent.errorMonitoringAllowed) {
        void started.stop();
        return;
      }
      sink = started;
      // Replay consent withdrawn while the SDK was resolving: the
      // subscription below could not see this sink to stop it.
      if (!consent.sessionReplayAllowed) void started.stopReplay();
    } finally {
      sinkStarting = false;
    }
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
    analytics.setSurface(surface);
    // ADR 0001: the marketing landing page loads no monitoring SDK, and
    // `app_opened` is not its event — `landing_cta_click` is.
    if (surface === "landing") return;
    monitoredSurfaceReached = true;
    openAnalyticsGate();
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

  // Delivered synchronously on subscribe, which is what wires the initial
  // state, and again on every change. Symmetric in both directions: a grant
  // rebuilds exactly what a withdrawal tore down.
  const unsubscribeConsent = consent.subscribe((state) => {
    // ADR 0002 decision 4: withdrawing replay stops the in-flight recording
    // rather than merely dropping it before send. Done *first*, and
    // unconditionally on the replay flag, so it happens whether replay alone
    // was withdrawn or the single control turned everything off — the sink
    // teardown below would otherwise take the handle away before we got here.
    //
    // A later re-grant does not resume *this* session's recording: replay is
    // configured when the SDK is constructed, so it takes effect on the next
    // load. That is the safe direction to be asymmetric in.
    if (!state.sessionReplay && sink) {
      void sink.stopReplay();
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
      // The transport is swapped in synchronously; it buffers internally until
      // the vendor SDK resolves, so `app_opened` is not lost to lazy loading.
      try {
        analytics.setTransport(createTransport());
      } catch {
        // Leaves the previous transport in place. Analytics fails open.
      }
    } else {
      // The boundary already refuses to send while consent is withdrawn;
      // dropping the transport as well means nothing is buffered either, and
      // opting the SDK out stops a client that is already running.
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
  config: { sessionReplay: boolean; override?: StartErrorSink },
): Promise<RunningSink> {
  const inert: RunningSink = {
    stop: async () => {},
    stopReplay: async () => {},
  };
  if (config.override) {
    const result = await config
      .override(RELEASE_SHA, { sessionReplay: config.sessionReplay })
      .catch(() => undefined);
    if (typeof result === "function") return { ...inert, stop: result };
    return result && typeof result.stop === "function"
      ? { stop: result.stop, stopReplay: result.stopReplay ?? inert.stopReplay }
      : inert;
  }
  try {
    const { SentrySink } = await import("./monitoring/sentrySink");
    const sink = new SentrySink({
      release: RELEASE_SHA,
      // ADR 0002 decision 4, honoured at the source: `false` here means the
      // replay integration is never constructed for this session.
      sessionReplay: config.sessionReplay,
    });
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
      stopReplay: () => sink.stopReplay(),
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

/** Maps a pathname onto the surface it belongs to. */
export function surfaceForPath(pathname: string): Surface {
  if (/^\/projects\/[^/]/.test(pathname)) return "editor";
  if (pathname === "/" || pathname === "") return "landing";
  return "dashboard";
}
