// The Sentry SDK is never loaded here. Every test injects a fake module
// through `SentrySinkOptions.load`, which is what lets this file assert the
// ADR 0001 and ADR 0011 configuration decisions — `sendDefaultPii` off,
// console breadcrumbs disabled rather than filtered, and no Session Replay at
// all, since replay moved to PostHog — as facts about the options object
// rather than as comments nobody checks.

import { describe, expect, it, vi } from "vitest";
import { UNKNOWN_BROWSER } from "./browserInfo";
import type { ErrorReport } from "./errorReporting";
import { SentrySink } from "./sentrySink";

type InitOptions = Record<string, unknown>;

function fakeSentry() {
  const inits: InitOptions[] = [];
  const captures: { error: unknown; context: Record<string, unknown> }[] = [];
  const close = vi.fn(async () => true);
  const integration = (name: string) => (options?: unknown) => ({
    name,
    options,
  });
  return {
    module: {
      init: (options: InitOptions) => void inits.push(options),
      captureException: (error: unknown, context: Record<string, unknown>) =>
        void captures.push({ error, context }),
      getClient: () => ({ close }),
      browserSessionIntegration: integration("BrowserSession"),
      dedupeIntegration: integration("Dedupe"),
      breadcrumbsIntegration: integration("Breadcrumbs"),
      replayIntegration: integration("Replay"),
      replayCanvasIntegration: integration("ReplayCanvas"),
    },
    inits,
    captures,
    close,
  };
}

/** The integration list the SDK was handed, with each one's own options. */
function integrations(options: InitOptions) {
  return options.integrations as {
    name: string;
    options?: Record<string, unknown>;
  }[];
}

function report(overrides: Partial<ErrorReport> = {}): ErrorReport {
  return {
    area: "shell",
    code: "unknown",
    fatal: false,
    message: "redacted message",
    releaseSha: "abc123def456",
    browser: {
      ...UNKNOWN_BROWSER,
      browserName: "firefox",
      browserVersion: "142",
    },
    context: {},
    error: new Error("boom"),
    fingerprint: "shell|unknown|redacted message|",
    ...overrides,
  };
}

async function started({
  dsn = "https://examplePublicKey@o0.ingest.invalid/0",
}: {
  dsn?: string;
} = {}) {
  const sentry = fakeSentry();
  const sink = new SentrySink({
    dsn,
    release: "abc123def456",
    load: async () => sentry.module as never,
  });
  const ok = await sink.start();
  return { sentry, sink, ok, options: sentry.inits[0] };
}

describe("privacy configuration (ADR 0001)", () => {
  it("turns sendDefaultPii off", async () => {
    const { options } = await started();
    expect(options.sendDefaultPii).toBe(false);
  });

  it("disables console breadcrumbs rather than filtering them", async () => {
    const { options } = await started();
    const breadcrumbs = integrations(options).find(
      (integration) => integration.name === "Breadcrumbs",
    );
    expect(breadcrumbs?.options?.console).toBe(false);
  });

  it("uses an explicit minimal integration set with no default integrations", async () => {
    // `defaultIntegrations: false` also switches off Sentry's own
    // globalHandlers, so our boundary stays the single capture point.
    const { options } = await started();
    expect(options.defaultIntegrations).toBe(false);
    expect(
      integrations(options)
        .map((i) => i.name)
        .sort(),
    ).toEqual(["Breadcrumbs", "BrowserSession", "Dedupe"]);
  });

  it("enables the session integration Release Health needs", async () => {
    // The PRD section 11 crash-free session rate comes from this rather than
    // from a hand-built derivation.
    const { options } = await started();
    expect(
      (options.integrations as { name: string }[]).some(
        (i) => i.name === "BrowserSession",
      ),
    ).toBe(true);
  });

  it("sends no performance traces", async () => {
    const { options } = await started();
    expect(options.tracesSampleRate).toBe(0);
  });

  it("scrubs through beforeSend and beforeBreadcrumb", async () => {
    const { options } = await started();
    const beforeSend = options.beforeSend as (event: unknown) => {
      extra?: unknown;
    };
    const beforeBreadcrumb = options.beforeBreadcrumb as (crumb: unknown) => unknown;

    expect(beforeSend({ extra: { project: "Midnight Drive" } }).extra).toBeUndefined();
    expect(beforeBreadcrumb({ category: "console", message: "x" })).toBeNull();
  });

  it("stamps the release so a report ties back to the deployed revision", async () => {
    const { options } = await started();
    expect(options.release).toBe("abc123def456");
    expect(options.dsn).toBe("https://examplePublicKey@o0.ingest.invalid/0");
  });
});

describe("no Session Replay (ADR 0011 decision 2, GRV-120)", () => {
  // Replay moved to PostHog, so only one vendor ever records. Sentry builds no
  // replay integration and samples nothing, so neither guard is load-bearing
  // on its own.
  it("constructs no replay integration", async () => {
    const { options } = await started();
    expect(integrations(options).map((i) => i.name)).not.toContain("Replay");
    expect(integrations(options).map((i) => i.name)).not.toContain("ReplayCanvas");
  });

  it("samples no sessions and never records on error", async () => {
    const { options } = await started();
    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBe(0);
  });
});

describe("capture", () => {
  it("marks a fatal report unhandled, which is what crashes the session", async () => {
    const { sentry, sink } = await started();
    sink.capture(report({ fatal: true }));
    expect(sentry.captures[0].context).toMatchObject({
      mechanism: { handled: false },
    });
  });

  it("leaves a non-fatal report handled", async () => {
    const { sentry, sink } = await started();
    sink.capture(report({ fatal: false }));
    expect(sentry.captures[0].context).toMatchObject({
      mechanism: { handled: true },
    });
  });

  it("tags area, code, and browser without any free text", async () => {
    const { sentry, sink } = await started();
    sink.capture(report({ area: "audio", code: "autoplay_blocked" }));
    const context = sentry.captures[0].context.captureContext as {
      tags: Record<string, unknown>;
      level: string;
    };
    expect(context.tags).toEqual({
      area: "audio",
      error_code: "autoplay_blocked",
      fatal: false,
      browser_name: "firefox",
      browser_version: "142",
      engine_name: "other",
      engine_version: "unknown",
    });
    expect(context.level).toBe("error");
  });

  it("adds the report's triage context as tags (GRV-55)", async () => {
    const { sentry, sink } = await started();
    sink.capture(
      report({ area: "export", context: { export_type: "stems", zip_count: 3 } }),
    );
    const context = sentry.captures[0].context.captureContext as {
      tags: Record<string, unknown>;
    };
    expect(context.tags).toMatchObject({
      area: "export",
      export_type: "stems",
      zip_count: 3,
    });
  });

  it("passes the original error so Sentry can symbolicate its stack", async () => {
    const { sentry, sink } = await started();
    const error = new Error("boom");
    sink.capture(report({ error }));
    expect(sentry.captures[0].error).toBe(error);
  });
});

describe("lazy start", () => {
  it("does nothing without a DSN, rather than failing", async () => {
    const sentry = fakeSentry();
    const sink = new SentrySink({
      dsn: "",
      load: async () => sentry.module as never,
    });
    expect(await sink.start()).toBe(false);
    expect(sentry.inits).toHaveLength(0);
  });

  it("resolves false when the SDK chunk cannot be loaded", async () => {
    // An ad blocker, an offline first load, or a chunk that 404s after a
    // rollback. None of these may surface to the user.
    const sink = new SentrySink({
      dsn: "https://k@o0.ingest.invalid/0",
      load: async () => {
        throw new Error("blocked");
      },
    });
    expect(await sink.start()).toBe(false);
    expect(sink.isReady).toBe(false);
  });

  it("is idempotent and loads the SDK only once", async () => {
    const sentry = fakeSentry();
    const load = vi.fn(async () => sentry.module as never);
    const sink = new SentrySink({ dsn: "https://k@o0.ingest.invalid/0", load });
    await Promise.all([sink.start(), sink.start()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("buffers a crash that happens before the SDK is ready, then flushes it", async () => {
    // Startup crashes are the most valuable kind; the lazy-loading
    // requirement must not be what loses them.
    const sentry = fakeSentry();
    const sink = new SentrySink({
      dsn: "https://k@o0.ingest.invalid/0",
      load: async () => sentry.module as never,
    });
    sink.capture(report({ message: "during startup" }));
    expect(sentry.captures).toHaveLength(0);

    await sink.start();

    expect(sentry.captures).toHaveLength(1);
  });

  it("bounds the buffer so an error loop before start cannot grow memory", async () => {
    const sentry = fakeSentry();
    const sink = new SentrySink({
      dsn: "https://k@o0.ingest.invalid/0",
      load: async () => sentry.module as never,
    });
    for (let i = 0; i < 100; i += 1) sink.capture(report());
    await sink.start();
    expect(sentry.captures.length).toBeLessThanOrEqual(20);
  });
});

describe("stop (consent withdrawn mid-session)", () => {
  it("closes the client and stops capturing", async () => {
    // `browserSessionIntegration` emits session updates on its own, so the
    // client itself has to be closed, not just unsubscribed from.
    const { sentry, sink } = await started();
    await sink.stop();
    expect(sentry.close).toHaveBeenCalled();

    sink.capture(report());
    expect(sentry.captures).toHaveLength(0);
  });

  it("discards anything still buffered", async () => {
    const sentry = fakeSentry();
    const sink = new SentrySink({
      dsn: "https://k@o0.ingest.invalid/0",
      load: async () => sentry.module as never,
    });
    sink.capture(report());
    await sink.stop();
    await sink.start();
    expect(sentry.captures).toHaveLength(0);
  });
});
