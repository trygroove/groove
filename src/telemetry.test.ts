import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics, analytics } from "./analytics/analytics";
import type { Surface } from "./analytics/catalog";
import { ConsentStore } from "./analytics/consent";
import {
  createPostHogLoader,
  type PostHogClient,
  type PostHogLoader,
  type PostHogLoadOptions,
  type PostHogPersistence,
} from "./analytics/posthogTransport";
import {
  createFailingTransport,
  createRecordingTransport,
  noopTransport,
  type RecordingTransport,
} from "./analytics/transport";
import { updateTrack } from "./commands";
import { createCommandHistory } from "./commands/history";
import { createCommandTestProject } from "./commands/testProjects";
import {
  type ErrorReport,
  ErrorReporter,
  type ErrorSink,
} from "./monitoring/errorReporting";
import { ProjectAutosave } from "./persistence/autosave";
import { InMemoryProjectRepository } from "./persistence/inMemoryProjectRepository";
import { createManualScheduler } from "./shared/scheduler";
import {
  afterFirstPaint,
  afterLandingSettled,
  createRouteTracker,
  initTelemetry,
  LANDING_ANALYTICS_DELAY_MS,
  type StartErrorSink,
  surfaceForPath,
} from "./telemetry";
import { memoryStorage } from "./testing/storage";

/** A target with no real `window` behind it. */
function fakeTarget() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    total() {
      return [...listeners.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}

/** Collects the tasks `initTelemetry` defers, so a test can decide when to run. */
function deferredPaint() {
  const tasks: (() => void)[] = [];
  return {
    /** Queues a task; the canceller it returns takes it back out. */
    schedule: (task: () => void) => {
      tasks.push(task);
      return () => {
        const index = tasks.indexOf(task);
        if (index !== -1) tasks.splice(index, 1);
      };
    },
    get pending() {
      return tasks.length;
    },
    flush() {
      for (const task of tasks.splice(0, tasks.length)) task();
    },
  };
}

/** Drains the microtask chain a deferred sink start resolves through. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  // The analytics boundary is an app-wide singleton; reset the transport so
  // one test's events cannot be observed by the next.
  analytics.setTransport(noopTransport);
});

describe("surfaceForPath", () => {
  it("maps each route onto its surface", () => {
    expect(surfaceForPath("/")).toBe("landing");
    expect(surfaceForPath("")).toBe("landing");
    expect(surfaceForPath("/projects")).toBe("dashboard");
    expect(surfaceForPath("/projects/")).toBe("dashboard");
    expect(surfaceForPath("/projects/prj_abc")).toBe("editor");
  });
});

describe("createRouteTracker: the router's page views (GRV-106)", () => {
  function setup() {
    const boundary = { setSurface: vi.fn(), pageview: vi.fn() };
    const telemetry = { setSurface: vi.fn() };
    return { boundary, telemetry, track: createRouteTracker(boundary) };
  }

  it("sends nothing before telemetry resolves, then one view for the entry path", () => {
    const { boundary, telemetry, track } = setup();

    track("/projects", null);
    expect(boundary.setSurface).toHaveBeenCalledWith("dashboard");
    expect(boundary.pageview).not.toHaveBeenCalled();

    track("/projects", telemetry);
    expect(telemetry.setSurface).toHaveBeenCalledWith("dashboard");
    expect(boundary.pageview).toHaveBeenCalledTimes(1);
  });

  it("sends one view per new pathname and none for a repeat", () => {
    const { boundary, telemetry, track } = setup();

    track("/", telemetry);
    track("/projects", telemetry);
    track("/projects", telemetry);
    track("/projects/prj_1", telemetry);

    expect(boundary.pageview).toHaveBeenCalledTimes(3);
    expect(telemetry.setSurface.mock.calls.map(([surface]) => surface)).toEqual([
      "landing",
      "dashboard",
      "dashboard",
      "editor",
    ]);
  });
});

describe("lazy initialization (PRD OPS-03, section 10 budgets)", () => {
  function setup(surface: "landing" | "dashboard" | "editor") {
    const consent = new ConsentStore(memoryStorage());
    const paint = deferredPaint();
    const startErrorSink = vi.fn(async () => {});
    const transport = createRecordingTransport();
    const telemetry = initTelemetry({
      surface,
      consent,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink,
      createAnalyticsTransport: () => transport,
      setVendorAnalyticsCollection: () => {},
    });
    return { consent, paint, startErrorSink, transport, telemetry };
  }

  it("does not load the monitoring SDK during init, only after first paint", () => {
    const { paint, startErrorSink } = setup("editor");

    expect(startErrorSink).not.toHaveBeenCalled();
    expect(paint.pending).toBe(1);

    paint.flush();
    expect(startErrorSink).toHaveBeenCalledTimes(1);
  });

  it("never loads it on the marketing landing page (ADR 0001)", () => {
    const { paint, startErrorSink } = setup("landing");

    paint.flush();

    expect(paint.pending).toBe(0);
    expect(startErrorSink).not.toHaveBeenCalled();
  });

  it("still wires analytics on the landing page, where landing_cta_click lives", () => {
    const { transport } = setup("landing");
    analytics.log("app_opened");
    expect(transport.events).toHaveLength(1);
  });

  it("attaches the analytics transport synchronously, so early events are not lost", () => {
    // No paint flush: `app_opened` fires during init, before the deferred
    // monitoring load runs, and must already have a real transport to land on.
    const { transport } = setup("editor");
    expect(transport.named("app_opened")).toHaveLength(1);
  });
});

describe("consent (PRD OPS-02 opt-out)", () => {
  it("does not start the monitoring SDK for a user who has opted out", () => {
    const consent = new ConsentStore(memoryStorage());
    consent.optOut();
    const paint = deferredPaint();
    const startErrorSink = vi.fn(async () => {});

    initTelemetry({
      surface: "editor",
      consent,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink,
      createAnalyticsTransport: createRecordingTransport,
      setVendorAnalyticsCollection: () => {},
    });
    paint.flush();

    expect(startErrorSink).not.toHaveBeenCalled();
  });

  it("does not attach a vendor analytics transport for a user who has opted out", () => {
    const consent = new ConsentStore(memoryStorage());
    consent.optOut();
    const createAnalyticsTransport = vi.fn(createRecordingTransport);

    initTelemetry({
      surface: "editor",
      consent,
      target: fakeTarget(),
      afterPaint: () => {},
      createAnalyticsTransport,
      setVendorAnalyticsCollection: () => {},
    });

    expect(createAnalyticsTransport).not.toHaveBeenCalled();
  });

  it("does not start it when consent is withdrawn before the deferred start runs", () => {
    // The window between `initTelemetry` and first paint is two animation
    // frames plus an idle callback, and the disclosure is on screen for all of
    // it. Starting anyway would run `sentry.init()` — and transmit a Release
    // Health session — for a user who has just declined.
    const consent = new ConsentStore(memoryStorage());
    const paint = deferredPaint();
    const startErrorSink = vi.fn(async () => {});

    initTelemetry({
      surface: "editor",
      consent,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink,
      createAnalyticsTransport: createRecordingTransport,
      setVendorAnalyticsCollection: () => {},
    });
    consent.optOut();
    paint.flush();

    expect(startErrorSink).not.toHaveBeenCalled();
  });

  it("stops the sink when consent is withdrawn while it is still loading", async () => {
    // Opt-out landing after the deferred start but before the sink resolves:
    // `stopSink` is still null, so the consent subscription cannot see it and
    // the resolution path has to stop it itself. Otherwise the sink stays
    // attached for the rest of the session.
    const consent = new ConsentStore(memoryStorage());
    const paint = deferredPaint();
    const stop = vi.fn(async () => {});
    let finishLoading: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const startErrorSink = vi.fn(async () => {
      await loaded;
      return stop;
    });

    initTelemetry({
      surface: "editor",
      consent,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink,
      createAnalyticsTransport: createRecordingTransport,
      setVendorAnalyticsCollection: () => {},
    });
    paint.flush();
    expect(startErrorSink).toHaveBeenCalledTimes(1);

    consent.optOut();
    finishLoading();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("keeps a sink that started while consent was still granted", async () => {
    // The counterpart: the re-checks must not tear down a legitimate sink.
    const consent = new ConsentStore(memoryStorage());
    const paint = deferredPaint();
    const stop = vi.fn(async () => {});
    const telemetry = initTelemetry({
      surface: "editor",
      consent,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink: async () => stop,
      createAnalyticsTransport: createRecordingTransport,
      setVendorAnalyticsCollection: () => {},
    });
    paint.flush();
    // A macrotask tick drains the start promise's microtask chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stop).not.toHaveBeenCalled();

    // It is still the disposer's to stop.
    await telemetry.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops sending when consent is withdrawn mid-session", () => {
    const consent = new ConsentStore(memoryStorage());
    const transport = createRecordingTransport();
    initTelemetry({
      surface: "editor",
      consent,
      target: fakeTarget(),
      afterPaint: () => {},
      startErrorSink: async () => {},
      createAnalyticsTransport: () => transport,
      setVendorAnalyticsCollection: () => {},
    });

    // Init logged `app_opened` on reaching the editor surface.
    expect(transport.named("app_opened")).toHaveLength(1);

    consent.optOut();
    analytics.log("app_opened");

    expect(transport.named("app_opened")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Session Replay consent, honoured at the source (ADR 0002 decision 4)
// ---------------------------------------------------------------------------

describe("Session Replay consent (ADR 0002 decision 4, ADR 0011 decision 2)", () => {
  /** A PostHog loader whose load options and replay stop are observable. */
  function replayLoader() {
    const loads: PostHogLoadOptions[] = [];
    const loader = {
      load: vi.fn(
        async (_persistence: PostHogPersistence, options?: PostHogLoadOptions) => {
          if (options) loads.push(options);
          return null;
        },
      ),
      client: new Promise<PostHogClient | null>(() => {}),
      setCollection: vi.fn(),
      stopSessionRecording: vi.fn(),
      startAppCollection: vi.fn(),
    } satisfies PostHogLoader;
    return { loader, loads };
  }

  function start(consent: ConsentStore) {
    const paint = deferredPaint();
    const { loader, loads } = replayLoader();
    const stop = vi.fn(async () => {});
    const telemetry = initTelemetry({
      surface: "editor",
      consent,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink: async () => stop,
      postHogLoader: loader,
      createPostHogErrorSink: () => null,
    });
    paint.flush();
    return { paint, telemetry, loader, loads, stop };
  }

  it("lets the analytics client record only while replay consent allows it", async () => {
    // The loader reads the flag when it decides, not when it was scheduled:
    // the disclosure is reachable throughout the wait for first paint.
    const consent = new ConsentStore(memoryStorage());
    const { loads } = start(consent);
    await tick();

    expect(loads).toHaveLength(1);
    expect(loads[0].sessionReplayAllowed()).toBe(true);
    consent.set({ sessionReplay: false });
    expect(loads[0].sessionReplayAllowed()).toBe(false);
  });

  it("stops the in-flight recording when replay is withdrawn mid-session", async () => {
    // "Opting out mid-session stops an in-flight recording rather than merely
    // dropping it before send."
    const consent = new ConsentStore(memoryStorage());
    const { loader } = start(consent);
    await tick();
    expect(loader.stopSessionRecording).not.toHaveBeenCalled();

    consent.set({ sessionReplay: false });

    expect(loader.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("keeps analytics and error monitoring running when only replay is withdrawn", async () => {
    const consent = new ConsentStore(memoryStorage());
    const { loader, stop, telemetry } = start(consent);
    await tick();

    consent.set({ sessionReplay: false });
    await tick();

    expect(loader.setCollection).not.toHaveBeenCalledWith(false, expect.anything());
    expect(stop).not.toHaveBeenCalled();
    // And the sink is still the disposer's to stop, so nothing has leaked.
    await telemetry.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("tells the loader for a session that declined replay before anything loaded", () => {
    // Honoured at the source as well: the loader will not start a recording
    // for this page load at all.
    const consent = new ConsentStore(memoryStorage());
    consent.set({ sessionReplay: false });
    const { loader } = start(consent);
    expect(loader.stopSessionRecording).toHaveBeenCalled();
  });

  it("withdrawing everything stops the recording, analytics and the sinks", async () => {
    const consent = new ConsentStore(memoryStorage());
    const { loader, stop } = start(consent);
    await tick();

    consent.optOut();

    expect(loader.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(loader.setCollection).toHaveBeenLastCalledWith(false, expect.anything());
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });
});

describe("errors go to Sentry and PostHog (ADR 0011 decision 3)", () => {
  function recordingSink() {
    const reports: ErrorReport[] = [];
    const sink = {
      capture: (report: ErrorReport) => void reports.push(report),
      stop: vi.fn(),
    };
    return { sink, reports };
  }

  function setup(consent = new ConsentStore(memoryStorage())) {
    const reporter = new ErrorReporter({
      consent,
      analytics: new Analytics({
        transport: createRecordingTransport(),
        consent,
        storage: memoryStorage(),
      }),
    });
    const postHog = recordingSink();
    const sentryStop = vi.fn(async () => {});
    const paint = deferredPaint();
    const telemetry = initTelemetry({
      surface: "editor",
      consent,
      reporter,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink: async () => sentryStop,
      createAnalyticsTransport: createRecordingTransport,
      setVendorAnalyticsCollection: () => {},
      stopSessionReplay: () => {},
      createPostHogErrorSink: () => postHog.sink,
    });
    return { consent, reporter, postHog, sentryStop, paint, telemetry };
  }

  it("attaches the PostHog sink when monitoring starts, not before", async () => {
    const { reporter, postHog, paint } = setup();
    reporter.report(new Error("before"), { area: "shell", fatal: false });
    expect(postHog.reports).toHaveLength(0);

    paint.flush();
    await tick();
    reporter.report(new Error("after"), { area: "shell", fatal: false });

    expect(postHog.reports.map((report) => report.message)).toEqual(["after"]);
  });

  it("never attaches it for a session that declined error monitoring", async () => {
    const consent = new ConsentStore(memoryStorage());
    consent.set({ errorMonitoring: false });
    const { reporter, postHog, paint } = setup(consent);
    paint.flush();
    await tick();

    reporter.report(new Error("boom"), { area: "shell", fatal: false });
    expect(postHog.reports).toHaveLength(0);
  });

  it("detaches and stops it, with Sentry's, when error monitoring is withdrawn", async () => {
    const { consent, reporter, postHog, sentryStop, paint } = setup();
    paint.flush();
    await tick();

    consent.set({ errorMonitoring: false });
    await vi.waitFor(() => expect(sentryStop).toHaveBeenCalledTimes(1));
    expect(postHog.sink.stop).toHaveBeenCalledTimes(1);

    consent.set({ errorMonitoring: true });
    reporter.report(new Error("withdrawn"), { area: "shell", fatal: false });
    expect(postHog.reports.map((report) => report.message)).not.toContain("withdrawn");
  });

  it("still attaches Sentry's when the PostHog sink cannot be built", async () => {
    const consent = new ConsentStore(memoryStorage());
    const sentryStop = vi.fn(async () => {});
    const paint = deferredPaint();
    const telemetry = initTelemetry({
      surface: "editor",
      consent,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink: async () => sentryStop,
      createAnalyticsTransport: createRecordingTransport,
      setVendorAnalyticsCollection: () => {},
      stopSessionReplay: () => {},
      createPostHogErrorSink: () => {
        throw new Error("posthog unavailable");
      },
    });
    paint.flush();
    await tick();

    await telemetry.dispose();
    expect(sentryStop).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Consent governs collection on every path, not just at the initial URL
// ---------------------------------------------------------------------------

/** One telemetry wiring with every vendor seam replaced by a spy. */
function wire(
  surface: Surface,
  overrides: {
    consent?: ConsentStore;
    startErrorSink?: StartErrorSink;
    createAnalyticsTransport?: () => RecordingTransport;
  } = {},
) {
  const consent = overrides.consent ?? new ConsentStore(memoryStorage());
  const paint = deferredPaint();
  const startErrorSink = vi.fn<StartErrorSink>(
    overrides.startErrorSink ?? (async () => {}),
  );
  const transports: RecordingTransport[] = [];
  const createAnalyticsTransport = vi.fn(() => {
    const transport = (overrides.createAnalyticsTransport ?? createRecordingTransport)();
    transports.push(transport);
    return transport;
  });
  const setVendorAnalyticsCollection = vi.fn();
  const telemetry = initTelemetry({
    surface,
    consent,
    target: fakeTarget(),
    afterPaint: paint.schedule,
    startErrorSink,
    createAnalyticsTransport,
    setVendorAnalyticsCollection,
  });
  return {
    consent,
    paint,
    startErrorSink,
    createAnalyticsTransport,
    setVendorAnalyticsCollection,
    telemetry,
    transports,
    /** The transport currently attached to the boundary. */
    get transport() {
      return transports[transports.length - 1];
    },
  };
}

describe("monitoring follows the surface reached, not the entry URL", () => {
  // A landing session that clicks "Sign in" is client-navigated to the
  // dashboard with no page load, so a decision taken once from
  // `window.location.pathname` never gets revisited. Leaving monitoring off for
  // that whole session drops it out of both halves of the PRD section 11
  // crash-free session rate and out of the `app_opened` denominator.

  it("starts the sink when a landing session navigates to the dashboard", () => {
    const { paint, startErrorSink, telemetry } = wire("landing");
    paint.flush();
    expect(startErrorSink).not.toHaveBeenCalled();

    telemetry.setSurface("dashboard");
    paint.flush();

    expect(startErrorSink).toHaveBeenCalledTimes(1);
  });

  it("logs app_opened on that first non-landing transition", () => {
    const { telemetry, transport } = wire("landing");
    expect(transport.named("app_opened")).toHaveLength(0);

    telemetry.setSurface("dashboard");

    expect(transport.named("app_opened")).toHaveLength(1);
  });

  it("starts the sink and logs app_opened exactly once across later navigations", async () => {
    const { paint, startErrorSink, telemetry, transport } = wire("landing");

    telemetry.setSurface("dashboard");
    paint.flush();
    await tick();
    telemetry.setSurface("editor");
    telemetry.setSurface("dashboard");
    paint.flush();

    expect(startErrorSink).toHaveBeenCalledTimes(1);
    expect(transport.named("app_opened")).toHaveLength(1);
  });

  it("starts nothing while the session stays on the landing page", () => {
    const { paint, startErrorSink, telemetry, transport } = wire("landing");

    telemetry.setSurface("landing");
    paint.flush();

    expect(paint.pending).toBe(0);
    expect(startErrorSink).not.toHaveBeenCalled();
    expect(transport.named("app_opened")).toHaveLength(0);
  });

  it("still logs app_opened once for a session that deep-links into the editor", () => {
    const { telemetry, transport } = wire("editor");
    telemetry.setSurface("editor");
    expect(transport.named("app_opened")).toHaveLength(1);
  });
});

describe("re-granting consent resumes collection (PRD OPS-02)", () => {
  // Withdrawal tears the transport and the sink down. A toggle that only works
  // in one direction leaves a user who changes their mind uncollected for the
  // rest of the page's life, with the checkbox showing "on".

  it("re-creates the analytics transport when the user opts back in", () => {
    const wiring = wire("editor");

    wiring.consent.optOut();
    wiring.consent.optIn();
    analytics.log("app_opened");

    expect(wiring.transports).toHaveLength(2);
    expect(wiring.transports[1]?.named("app_opened")).toHaveLength(1);
  });

  it("restarts the error sink when the user opts back in", async () => {
    const stop = vi.fn(async () => {});
    const wiring = wire("editor", { startErrorSink: async () => stop });

    wiring.paint.flush();
    await tick();
    expect(wiring.startErrorSink).toHaveBeenCalledTimes(1);

    wiring.consent.optOut();
    await tick();
    expect(stop).toHaveBeenCalledTimes(1);

    wiring.consent.optIn();
    wiring.paint.flush();

    expect(wiring.startErrorSink).toHaveBeenCalledTimes(2);
  });
});

describe("the vendor analytics SDK follows consent (PRD OPS-02)", () => {
  // Dropping the custom-event transport does not stop a PostHog client that is
  // already running: consent has to reach the SDK itself (`opt_out_capturing`),
  // or the disclosure's "turning this off stops collection" is untrue.

  it("never enables collection for a user who has already opted out", () => {
    const consent = new ConsentStore(memoryStorage());
    consent.optOut();
    const { setVendorAnalyticsCollection } = wire("editor", { consent });

    expect(setVendorAnalyticsCollection).toHaveBeenCalledWith(false, expect.anything());
    expect(setVendorAnalyticsCollection).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
    );
  });

  it("disables collection when consent is withdrawn mid-session", () => {
    const { consent, setVendorAnalyticsCollection } = wire("editor");
    expect(setVendorAnalyticsCollection).toHaveBeenLastCalledWith(true, "memory");

    consent.optOut();

    expect(setVendorAnalyticsCollection).toHaveBeenLastCalledWith(
      false,
      expect.anything(),
    );
  });

  it("re-enables collection, with cookie persistence, when the user opts back in", () => {
    const { consent, setVendorAnalyticsCollection } = wire("editor");

    consent.optOut();
    consent.optIn();

    expect(setVendorAnalyticsCollection).toHaveBeenLastCalledWith(
      true,
      "localStorage+cookie",
    );
  });
});

describe("the PostHog SDK loads lazily, on the landing page too (GRV-106, GRV-123)", () => {
  function fakeLoader() {
    return {
      load: vi.fn(
        async (_persistence: PostHogPersistence, _options?: PostHogLoadOptions) => null,
      ),
      client: new Promise<PostHogClient | null>(() => {}),
      setCollection: vi.fn(),
      stopSessionRecording: vi.fn(),
      startAppCollection: vi.fn(),
    } satisfies PostHogLoader;
  }

  function setup(surface: Surface, consent = new ConsentStore(memoryStorage())) {
    const paint = deferredPaint();
    const settle = deferredPaint();
    const postHogLoader = fakeLoader();
    const telemetry = initTelemetry({
      surface,
      consent,
      target: fakeTarget(),
      afterPaint: paint.schedule,
      afterLandingSettled: settle.schedule,
      startErrorSink: async () => {},
      postHogLoader,
    });
    return { paint, settle, postHogLoader, telemetry, consent };
  }

  it("loads it on the landing page once the page has loaded and settled, not at first paint", async () => {
    const { paint, settle, postHogLoader } = setup("landing");
    await tick();
    // First paint alone is too early on `/`: the SDK's parse would land in
    // the window that decides the page's LCP and TBT.
    paint.flush();
    await tick();
    expect(postHogLoader.load).not.toHaveBeenCalled();

    settle.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledTimes(1);
  });

  it("cancels the landing page's wait when disposed, so the SDK never loads", async () => {
    const { settle, postHogLoader, telemetry } = setup("landing");
    expect(settle.pending).toBe(1);
    await telemetry.dispose();
    expect(settle.pending).toBe(0);
    settle.flush();
    await tick();
    expect(postHogLoader.load).not.toHaveBeenCalled();
  });

  it("does not wait for the landing page to settle on an app surface", async () => {
    const { paint, settle, postHogLoader } = setup("editor");
    expect(settle.pending).toBe(0);
    paint.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledTimes(1);
  });

  it("loads it on the app's timing when the visitor moves on before / settles", async () => {
    const { paint, settle, postHogLoader, telemetry } = setup("landing");
    telemetry.setSurface("dashboard");
    paint.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledTimes(1);

    // The landing page settling later loads nothing more.
    settle.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledTimes(1);
  });

  it("collects analytics only on the landing page: no replay, vitals or error sink", async () => {
    const createPostHogErrorSink = vi.fn(() => null);
    const startErrorSink = vi.fn(async () => {});
    const paint = deferredPaint();
    const settle = deferredPaint();
    const postHogLoader = fakeLoader();
    initTelemetry({
      surface: "landing",
      consent: new ConsentStore(memoryStorage()),
      target: fakeTarget(),
      afterPaint: paint.schedule,
      afterLandingSettled: settle.schedule,
      startErrorSink,
      createPostHogErrorSink,
      postHogLoader,
    });
    paint.flush();
    settle.flush();
    paint.flush();
    await tick();

    expect(postHogLoader.load).toHaveBeenCalledTimes(1);
    expect(postHogLoader.startAppCollection).not.toHaveBeenCalled();
    expect(startErrorSink).not.toHaveBeenCalled();
    expect(createPostHogErrorSink).not.toHaveBeenCalled();
  });

  it("starts app collection when the session moves on into the app", async () => {
    const { paint, settle, postHogLoader, telemetry } = setup("landing");
    paint.flush();
    settle.flush();
    await tick();
    expect(postHogLoader.startAppCollection).not.toHaveBeenCalled();

    telemetry.setSurface("dashboard");
    expect(postHogLoader.startAppCollection).toHaveBeenCalled();
    // The SDK the landing page loaded is the one the app keeps.
    paint.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledTimes(1);
  });

  it("starts app collection before the SDK loads on an app surface", () => {
    const { postHogLoader } = setup("editor");
    expect(postHogLoader.startAppCollection).toHaveBeenCalled();
    expect(postHogLoader.load).not.toHaveBeenCalled();
  });

  it("never loads it for a landing session that declined", async () => {
    const consent = new ConsentStore(memoryStorage());
    consent.optOut();
    const { paint, settle, postHogLoader } = setup("landing", consent);
    paint.flush();
    settle.flush();
    await tick();
    expect(postHogLoader.load).not.toHaveBeenCalled();
  });

  it("never loads it for a landing session that declines before the page settles", async () => {
    const { consent, paint, settle, postHogLoader } = setup("landing");
    consent.optOut();
    paint.flush();
    settle.flush();
    await tick();
    expect(postHogLoader.load).not.toHaveBeenCalled();
  });

  it("loads it only after first paint on an app surface", async () => {
    const { paint, postHogLoader } = setup("editor");
    await tick();
    expect(postHogLoader.load).not.toHaveBeenCalled();

    paint.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledTimes(1);
  });

  it("loads it once when the session navigates off a settled landing page", async () => {
    const { paint, settle, postHogLoader, telemetry } = setup("landing");
    paint.flush();
    settle.flush();
    telemetry.setSurface("dashboard");
    paint.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledTimes(1);
  });

  it("keeps identity in memory until the user has chosen", async () => {
    const { paint, postHogLoader } = setup("editor");
    paint.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledWith("memory", expect.anything());
  });

  it("persists it in localStorage and a cookie once the user has granted consent", async () => {
    const storage = memoryStorage();
    const chosen = new ConsentStore(storage);
    chosen.optOut();
    chosen.optIn();
    const { paint, postHogLoader } = setup("editor", new ConsentStore(storage));
    paint.flush();
    await tick();
    expect(postHogLoader.load).toHaveBeenCalledWith(
      "localStorage+cookie",
      expect.anything(),
    );
  });

  it("never loads it for an opted-out session, and opts a running client out", async () => {
    const consent = new ConsentStore(memoryStorage());
    consent.optOut();
    const { paint, postHogLoader } = setup("editor", consent);
    paint.flush();
    await tick();
    expect(postHogLoader.load).not.toHaveBeenCalled();
    expect(postHogLoader.setCollection).toHaveBeenLastCalledWith(
      false,
      "localStorage+cookie",
    );
  });

  it("runs on noopTransport when no PostHog key is configured", () => {
    const transportBefore = createRecordingTransport();
    analytics.setTransport(transportBefore);
    initTelemetry({
      surface: "editor",
      consent: new ConsentStore(memoryStorage()),
      target: fakeTarget(),
      afterPaint: () => {},
      startErrorSink: async () => {},
      postHogLoader: null,
    });
    analytics.log("app_opened");
    // The recording transport was replaced, and nothing else received it.
    expect(transportBefore.named("app_opened")).toHaveLength(0);
  });
});

describe("withdrawing consent before the SDK loads (GRV-106)", () => {
  // The transport is made on the landing page, where its SDK load waits for
  // the page to load and settle. An opt-out in that window must
  // cancel the load and drop what it queued: otherwise the load runs anyway,
  // with cookie persistence, and sends the page view queued before the opt-out.

  function recordingClient() {
    const calls: { method: string; args: unknown[] }[] = [];
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
      };
    const client: PostHogClient = {
      capture: record("capture"),
      identify: record("identify"),
      reset: record("reset"),
      setPersonProperties: record("setPersonProperties"),
      register: record("register"),
      set_config: record("set_config"),
      opt_out_capturing: record("opt_out_capturing"),
      opt_in_capturing: record("opt_in_capturing"),
      has_opted_out_capturing: () => false,
      captureException: record("captureException"),
      get_session_id: () => "session",
      onSessionId: () => () => {},
      startSessionRecording: record("startSessionRecording"),
      stopSessionRecording: record("stopSessionRecording"),
    };
    return { client, calls };
  }

  function setup() {
    const { client, calls } = recordingClient();
    const init = vi.fn((_key: string, _config: unknown) => client);
    const consent = new ConsentStore(memoryStorage());
    const paint = deferredPaint();
    const telemetry = initTelemetry({
      surface: "landing",
      consent,
      target: fakeTarget(),
      // One flush opens both, which is all these tests need of the timing.
      afterPaint: paint.schedule,
      afterLandingSettled: paint.schedule,
      startErrorSink: async () => {},
      postHogLoader: createPostHogLoader({
        settings: { key: "phc_test", host: "https://eu.i.posthog.com" },
        importSdk: async () => ({ init }),
        importRecorder: async () => {},
        importWebVitals: async () => {},
      }),
    });
    return { calls, init, consent, paint, telemetry };
  }

  function captured(calls: { method: string; args: unknown[] }[]) {
    return calls.filter((call) => call.method === "capture").map((call) => call.args[0]);
  }

  it("never loads the SDK or sends what was queued before the opt-out", async () => {
    const { calls, init, consent, paint, telemetry } = setup();

    analytics.pageview();
    consent.optOut();
    telemetry.setSurface("dashboard");
    paint.flush();
    await tick();

    expect(init).not.toHaveBeenCalled();
    expect(captured(calls)).toEqual([]);
  });

  it("does not flush the old queue when consent is toggled off and on again", async () => {
    const { calls, init, consent, paint, telemetry } = setup();

    analytics.pageview();
    consent.optOut();
    consent.optIn();
    telemetry.setSurface("dashboard");
    paint.flush();
    await tick();

    expect(init).toHaveBeenCalledTimes(1);
    // Only what the dashboard sent after the re-grant: its `app_opened`.
    expect(captured(calls)).toEqual(["app_opened"]);
  });

  it("sends a landing-only visit's page view and CTA click without leaving / (GRV-123)", async () => {
    const { calls, init, paint } = setup();

    analytics.pageview();
    analytics.log("landing_cta_click", { cta_id: "request_access", placement: "hero" });
    paint.flush();
    await tick();

    expect(init).toHaveBeenCalledTimes(1);
    expect(captured(calls)).toEqual(["$pageview", "landing_cta_click"]);
    // Analytics only: the landing client starts with performance capture off
    // and no recording.
    expect(init.mock.calls[0][1]).toMatchObject({
      capture_performance: { web_vitals: false, network_timing: false },
      capture_pageleave: true,
    });
    expect(calls.map((call) => call.method)).not.toContain("startSessionRecording");
    expect(calls.map((call) => call.method)).not.toContain("captureException");
  });

  it("does not send the landing page view again when the visitor moves on", async () => {
    const { calls, paint, telemetry } = setup();
    const track = createRouteTracker();

    const visit = (url: string) => {
      history.pushState({}, "", url);
      track(location.pathname, telemetry);
    };
    try {
      visit("/?utm_source=newsletter");
      paint.flush();
      await tick();
      visit("/");
      visit("/projects");
      await tick();
    } finally {
      history.pushState({}, "", "/");
    }

    const views = calls
      .filter((call) => call.method === "capture" && call.args[0] === "$pageview")
      .map((call) => call.args[1] as Record<string, string>);
    expect(views.map((view) => view.$pathname)).toEqual(["/", "/projects"]);
    // The landing view keeps the campaign it arrived with.
    expect(views[0].$current_url).toContain("utm_source=newsletter");
    expect(views[0].utm_source).toBe("newsletter");
  });

  it("keeps the queue when a different consent flag changes", async () => {
    const { calls, consent, paint, telemetry } = setup();

    analytics.pageview();
    consent.set({ sessionReplay: false });
    telemetry.setSurface("dashboard");
    paint.flush();
    await tick();

    expect(captured(calls)).toEqual(["$pageview", "app_opened"]);
  });
});

describe("fail-open wiring (PRD OPS-02/OPS-03)", () => {
  it("starts the app when the analytics transport cannot even be created", () => {
    expect(() =>
      initTelemetry({
        surface: "editor",
        consent: new ConsentStore(memoryStorage()),
        target: fakeTarget(),
        afterPaint: () => {},
        createAnalyticsTransport: () => {
          throw new Error("posthog-js blocked");
        },
        setVendorAnalyticsCollection: () => {},
      }),
    ).not.toThrow();
  });

  it("survives a monitoring SDK that fails to load", () => {
    const paint = deferredPaint();
    initTelemetry({
      surface: "editor",
      consent: new ConsentStore(memoryStorage()),
      target: fakeTarget(),
      afterPaint: paint.schedule,
      startErrorSink: async () => {
        throw new Error("blocked by an ad blocker");
      },
      createAnalyticsTransport: createRecordingTransport,
      setVendorAnalyticsCollection: () => {},
    });

    expect(() => paint.flush()).not.toThrow();
  });
});

describe("dispose", () => {
  it("stops a sink that resolves after dispose", async () => {
    // Same shape as the consent-withdrawal race: `stopSink` is still null
    // while the sink is loading, so the disposer has nothing to await and a
    // sink resolving afterwards would stay attached for the rest of the page.
    const stop = vi.fn(async () => {});
    let finishLoading: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const wiring = wire("editor", {
      startErrorSink: async () => {
        await loaded;
        return stop;
      },
    });
    wiring.paint.flush();
    expect(wiring.startErrorSink).toHaveBeenCalledTimes(1);

    await wiring.telemetry.dispose();
    finishLoading();

    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("ignores a surface change that arrives after dispose", async () => {
    const wiring = wire("landing");

    await wiring.telemetry.dispose();
    wiring.telemetry.setSurface("dashboard");
    wiring.paint.flush();

    expect(wiring.startErrorSink).not.toHaveBeenCalled();
    expect(wiring.transport.named("app_opened")).toHaveLength(0);
  });

  it("removes the global handlers it installed", async () => {
    const target = fakeTarget();
    const telemetry = initTelemetry({
      surface: "editor",
      consent: new ConsentStore(memoryStorage()),
      target,
      afterPaint: () => {},
      createAnalyticsTransport: createRecordingTransport,
      setVendorAnalyticsCollection: () => {},
    });
    expect(target.total()).toBe(2);

    await telemetry.dispose();

    expect(target.total()).toBe(0);
  });
});

describe("afterFirstPaint", () => {
  it("runs the task", async () => {
    const task = vi.fn();
    afterFirstPaint(task);
    await vi.waitFor(() => expect(task).toHaveBeenCalled());
  });

  it("swallows a throwing task rather than breaking the app that just painted", async () => {
    const after = vi.fn();
    afterFirstPaint(() => {
      throw new Error("telemetry startup exploded");
    });
    afterFirstPaint(after);
    await vi.waitFor(() => expect(after).toHaveBeenCalled());
  });

  // `FND-001c` (#174): a background tab never paints, so
  // `requestAnimationFrame` is not called until it is foregrounded -- which
  // may be never. Gating monitoring on a frame meant a session opened in a
  // background tab (a restored window, a middle-click, a deep link opened
  // behind the current page) loaded no SDK at all and reported no crash.
  // The idle callback is what must still get there.
  it("runs the task in a tab that never paints", async () => {
    const rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(() => 0);
    try {
      const task = vi.fn();
      afterFirstPaint(task);
      await vi.waitFor(() => expect(task).toHaveBeenCalled());
    } finally {
      rafSpy.mockRestore();
    }
  });
});

describe("afterLandingSettled (GRV-123)", () => {
  function setReadyState(state: DocumentReadyState) {
    Object.defineProperty(document, "readyState", {
      configurable: true,
      get: () => state,
    });
  }

  afterEach(() => {
    // Back to jsdom's own getter on the prototype.
    delete (document as { readyState?: unknown }).readyState;
    vi.useRealTimers();
  });

  it("waits for the window load event, then the delay, then an idle main thread", async () => {
    vi.useFakeTimers();
    setReadyState("loading");
    const task = vi.fn();
    afterLandingSettled(task);

    await vi.advanceTimersByTimeAsync(LANDING_ANALYTICS_DELAY_MS * 2);
    expect(task).not.toHaveBeenCalled();

    setReadyState("complete");
    window.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(LANDING_ANALYTICS_DELAY_MS - 1);
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("counts the delay from now when the page has already loaded", async () => {
    vi.useFakeTimers();
    setReadyState("complete");
    const task = vi.fn();
    afterLandingSettled(task);

    await vi.advanceTimersByTimeAsync(LANDING_ANALYTICS_DELAY_MS - 1);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("removes its load listener when cancelled before the page has loaded", async () => {
    vi.useFakeTimers();
    setReadyState("loading");
    const remove = vi.spyOn(window, "removeEventListener");
    const task = vi.fn();
    const cancel = afterLandingSettled(task);
    cancel();
    expect(remove).toHaveBeenCalledWith("load", expect.any(Function));
    remove.mockRestore();

    setReadyState("complete");
    window.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(LANDING_ANALYTICS_DELAY_MS * 2);
    expect(task).not.toHaveBeenCalled();
  });

  it("clears its delay when cancelled after the page has loaded", async () => {
    vi.useFakeTimers();
    setReadyState("complete");
    const task = vi.fn();
    const cancel = afterLandingSettled(task);
    await vi.advanceTimersByTimeAsync(LANDING_ANALYTICS_DELAY_MS - 1);
    cancel();
    await vi.advanceTimersByTimeAsync(LANDING_ANALYTICS_DELAY_MS * 2);
    expect(task).not.toHaveBeenCalled();
  });

  it("does not run a task already waiting on an idle main thread once cancelled", async () => {
    vi.useFakeTimers();
    setReadyState("complete");
    // Hold the frame and idle callbacks, so the task is provably waiting on
    // them when the cancel comes.
    const held: (() => void)[] = [];
    const hold = (callback: () => void) => held.push(callback);
    vi.stubGlobal("requestAnimationFrame", hold);
    vi.stubGlobal("requestIdleCallback", hold);
    try {
      const task = vi.fn();
      const cancel = afterLandingSettled(task);
      await vi.advanceTimersByTimeAsync(LANDING_ANALYTICS_DELAY_MS);
      expect(held.length).toBeGreaterThan(0);
      cancel();
      for (const callback of held.splice(0)) callback();
      expect(task).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// The PRD OPS-02/OPS-03 acceptance criterion, end to end
// ---------------------------------------------------------------------------

describe("the core journey is identical with both transports failing", () => {
  /**
   * Edit → save → undo, the loop every later task builds on, run twice: once
   * with working telemetry and once with the analytics transport throwing,
   * the error sink throwing, and the user opted out. The two runs must be
   * indistinguishable in everything the *user* can observe.
   */
  async function journey(mode: "working" | "broken") {
    const consent = new ConsentStore(memoryStorage());
    if (mode === "broken") consent.optOut();
    // The "broken" run has every flag off, replay included: ADR 0002 decision
    // 4 requires that turning replay off costs no capability, exactly as
    // `OPS-02` requires of analytics. Asserted here rather than assumed, so a
    // later flag added to `optOut()` without being turned off is caught.
    if (mode === "broken") {
      expect(consent.current).toEqual({
        productAnalytics: false,
        errorMonitoring: false,
        sessionReplay: false,
      });
    }

    const analyticsBoundary = new Analytics({
      transport:
        mode === "broken" ? createFailingTransport() : createRecordingTransport(),
      consent,
      storage: memoryStorage(),
    });

    const explodingSink: ErrorSink = {
      capture() {
        throw new Error("sentry.io blocked");
      },
    };
    const reporter = new ErrorReporter({
      analytics: analyticsBoundary,
      consent,
      sinks: mode === "broken" ? [explodingSink] : [],
    });

    const fixture = createCommandTestProject();
    const history = createCommandHistory(fixture.project);
    const repository = new InMemoryProjectRepository();
    await repository.createProject(fixture.project);
    const scheduler = createManualScheduler();
    const autosave = new ProjectAutosave({
      repository,
      projectId: fixture.project.metadata.id,
      revision: fixture.project.metadata.revision,
      scheduler,
      analytics: analyticsBoundary,
    });

    // Edit.
    history.execute(updateTrack(fixture.trackAId, { name: "Sub" }));
    const named = history.project.song.tracks.find(
      (track) => track.id === fixture.trackAId,
    )?.name;

    // Save.
    autosave.queueSong(history.project.song);
    scheduler.runAll();
    const status = await autosave.flush();

    // Undo.
    history.undo();
    const afterUndo = history.project.song.tracks.find(
      (track) => track.id === fixture.trackAId,
    )?.name;

    // A reported failure along the way must also change nothing.
    reporter.report(new Error("mid-journey"), { area: "editor", fatal: false });

    autosave.dispose();
    return {
      named,
      afterUndo,
      saveState: status.state,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      revision: history.project.metadata.revision,
    };
  }

  it("produces the same result whether telemetry works or is entirely broken", async () => {
    const working = await journey("working");
    const broken = await journey("broken");

    expect(broken).toEqual(working);
    // And the journey actually did something, so an all-failing run cannot
    // pass by both sides being empty.
    expect(working.named).toBe("Sub");
    expect(working.afterUndo).not.toBe("Sub");
    expect(working.saveState).toBe("saved");
  });

  it("never throws out of the journey when every transport is failing", async () => {
    await expect(journey("broken")).resolves.toBeDefined();
  });
});
