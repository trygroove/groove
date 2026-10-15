// The PostHog error sink (ADR 0011 decision 3, GRV-120): one boundary, two
// sinks. The unit tests use a fake client; the payload test at the end runs
// the real `posthog-js` client with the transport's own init options, so the
// "no project content" rule is checked against the event PostHog actually
// builds rather than against a model of it.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { POSTHOG_DEFAULT_HOST, postHogInitOptions } from "../analytics/posthogTransport";
import { createRecordingTransport } from "../analytics/transport";
import { memoryStorage } from "../testing/storage";
import { UNKNOWN_BROWSER } from "./browserInfo";
import { CodedError, type ErrorReport, ErrorReporter } from "./errorReporting";
import {
  PostHogErrorSink,
  type PostHogExceptionClient,
  postHogExceptionProperties,
} from "./posthogSink";
import { SentrySink } from "./sentrySink";

function fakeClient() {
  const captured: { error: unknown; properties?: Record<string, unknown> }[] = [];
  const client: PostHogExceptionClient = {
    captureException: (error, properties) => void captured.push({ error, properties }),
  };
  return { client, captured };
}

function report(overrides: Partial<ErrorReport> = {}): ErrorReport {
  return {
    area: "persistence",
    code: "unavailable",
    fatal: false,
    message: "redacted message",
    releaseSha: "abc123def456",
    browser: { ...UNKNOWN_BROWSER, browserName: "firefox", browserVersion: "142" },
    error: new Error("boom"),
    fingerprint: "persistence|unavailable|redacted message|",
    ...overrides,
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function reporterWith(sinks: (SentrySink | PostHogErrorSink)[], consent?: ConsentStore) {
  const store = consent ?? new ConsentStore(memoryStorage());
  return new ErrorReporter({
    consent: store,
    analytics: new Analytics({
      transport: createRecordingTransport(),
      consent: store,
      storage: memoryStorage(),
    }),
    sinks,
    releaseSha: "abc123def456",
    browser: UNKNOWN_BROWSER,
  });
}

/** A started Sentry sink over a fake SDK, recording what it was asked to send. */
async function sentrySink() {
  const captures: unknown[] = [];
  const integration = () => () => ({});
  const sink = new SentrySink({
    dsn: "https://k@o0.ingest.invalid/0",
    load: async () =>
      ({
        init: () => {},
        captureException: (error: unknown) => void captures.push(error),
        getClient: () => ({ close: async () => true }),
        browserSessionIntegration: integration(),
        dedupeIntegration: integration(),
        breadcrumbsIntegration: integration(),
      }) as never,
  });
  await sink.start();
  return { sink, captures };
}

describe("PostHogErrorSink", () => {
  it("sends the report's error with its classification, never its content", async () => {
    const { client, captured } = fakeClient();
    const sink = new PostHogErrorSink(Promise.resolve(client));
    await tick();
    const error = new CodedError("unavailable", "save failed");
    sink.capture(report({ error, fatal: true }));

    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(error);
    expect(captured[0].properties).toEqual({
      $exception_level: "fatal",
      area: "persistence",
      error_code: "unavailable",
      fatal: true,
      release_sha: "abc123def456",
      browser_name: "firefox",
      browser_version: "142",
      engine_name: UNKNOWN_BROWSER.engineName,
      engine_version: UNKNOWN_BROWSER.engineVersion,
    });
  });

  it("marks a non-fatal report at error level", () => {
    expect(postHogExceptionProperties(report()).$exception_level).toBe("error");
  });

  it("never hands PostHog a thrown value that is not an Error", async () => {
    // A thrown object's fields could be project state. The redacted message is
    // all that goes.
    const { client, captured } = fakeClient();
    const sink = new PostHogErrorSink(Promise.resolve(client));
    await tick();
    sink.capture(
      report({
        error: { project: "Midnight Drive Demo" },
        message: "non-error thrown (object)",
      }),
    );

    expect(captured[0].error).toBeInstanceOf(Error);
    expect((captured[0].error as Error).message).toBe("non-error thrown (object)");
    expect(JSON.stringify(captured)).not.toContain("Midnight Drive Demo");
  });

  it("buffers reports until the analytics client loads, then sends them", async () => {
    let resolve: (client: PostHogExceptionClient) => void = () => {};
    const { client, captured } = fakeClient();
    const sink = new PostHogErrorSink(
      new Promise<PostHogExceptionClient>((r) => {
        resolve = r;
      }),
    );
    sink.capture(report({ message: "early" }));
    expect(captured).toHaveLength(0);

    resolve(client);
    await tick();
    expect(captured).toHaveLength(1);
  });

  it("bounds the buffer, so a client that never loads cannot grow it", async () => {
    let resolve: (client: PostHogExceptionClient) => void = () => {};
    const { client, captured } = fakeClient();
    const sink = new PostHogErrorSink(
      new Promise<PostHogExceptionClient>((r) => {
        resolve = r;
      }),
    );
    for (let i = 0; i < 50; i++) sink.capture(report({ message: `report ${i}` }));
    resolve(client);
    await tick();
    expect(captured).toHaveLength(20);
  });

  it("discards everything when there is no client to send through", async () => {
    const sink = new PostHogErrorSink(Promise.resolve(null));
    sink.capture(report());
    await tick();
    expect(() => sink.capture(report())).not.toThrow();
  });

  it("sends nothing once stopped", async () => {
    const { client, captured } = fakeClient();
    const sink = new PostHogErrorSink(Promise.resolve(client));
    await tick();
    sink.stop();
    sink.capture(report());
    expect(captured).toHaveLength(0);
  });

  it("never throws when the client does", async () => {
    const sink = new PostHogErrorSink(
      Promise.resolve({
        captureException: () => {
          throw new Error("posthog blocked");
        },
      }),
    );
    await tick();
    expect(() => sink.capture(report())).not.toThrow();
  });
});

describe("one boundary, two sinks (ADR 0011 decision 3)", () => {
  it("sends one report to both Sentry and PostHog", async () => {
    const sentry = await sentrySink();
    const { client, captured } = fakeClient();
    const postHog = new PostHogErrorSink(Promise.resolve(client));
    await tick();
    const reporter = reporterWith([sentry.sink, postHog]);
    const error = new Error("save failed");

    expect(reporter.report(error, { area: "persistence", fatal: false })).toBe(true);

    expect(sentry.captures).toEqual([error]);
    expect(captured.map((call) => call.error)).toEqual([error]);
  });

  it("keeps Sentry's delivery intact when the PostHog sink throws", async () => {
    const sentry = await sentrySink();
    const throwing = new PostHogErrorSink(Promise.resolve(fakeClient().client));
    vi.spyOn(throwing, "capture").mockImplementation(() => {
      throw new Error("posthog blocked");
    });
    const reporter = reporterWith([throwing, sentry.sink]);

    expect(() =>
      reporter.report(new Error("a"), { area: "shell", fatal: false }),
    ).not.toThrow();
    expect(() =>
      reporter.report(new Error("b"), { area: "shell", fatal: false }),
    ).not.toThrow();
    expect(sentry.captures).toHaveLength(2);
  });

  it("does not report a failing sink's own error", async () => {
    const sentry = await sentrySink();
    const throwing = new PostHogErrorSink(
      Promise.resolve({
        captureException: () => {
          throw new Error("posthog blocked");
        },
      }),
    );
    await tick();
    const reporter = reporterWith([throwing, sentry.sink]);

    reporter.report(new Error("once"), { area: "shell", fatal: false });

    expect(sentry.captures).toHaveLength(1);
  });

  it("sends to neither once error monitoring is declined", async () => {
    const consent = new ConsentStore(memoryStorage());
    consent.set({ errorMonitoring: false });
    const sentry = await sentrySink();
    const { client, captured } = fakeClient();
    const postHog = new PostHogErrorSink(Promise.resolve(client));
    await tick();

    reporterWith([sentry.sink, postHog], consent).report(new Error("x"), {
      area: "shell",
      fatal: false,
    });

    expect(sentry.captures).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });
});

/**
 * PRD `OPS-02` / `OPS-03` / section 10, the same list as `scrub.test.ts`: "no
 * project content, assistant text, user-entered strings, asset URLs, or
 * tokens".
 */
const FORBIDDEN = {
  projectName: "Midnight Drive Demo",
  trackName: "Lead Vocal Take 3",
  clipName: "Chorus Riff",
  assetName: "my-secret-sample.wav",
  assetUrl: "https://storage.googleapis.com/solid-groove/users/u1/kick.wav",
  assistantText: "Make the chorus feel more euphoric with a wide pad",
  email: "producer@example.com",
  token:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
} as const;

describe("the PostHog exception payload carries no project content (PRD OPS-03)", () => {
  // The real SDK, with the transport's real init options: its `before_send`
  // scrubber runs first, and a recorder appended after it keeps what would
  // have been sent and sends nothing.
  const sent: { event: string; properties: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  let client: PostHogExceptionClient;

  beforeAll(async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const { default: posthog } = await import("posthog-js");
    const options = postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory");
    const instance = posthog.init("phc_payload_test", {
      ...options,
      before_send: [
        options.before_send as never,
        (event) => {
          if (event) sent.push(event as never);
          return null;
        },
      ],
    });
    if (!instance) throw new Error("posthog-js did not initialize");
    client = instance;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  function exceptions() {
    return sent.filter((event) => event.event === "$exception");
  }

  it("removes every forbidden value from a hostile error and its cause", async () => {
    const sink = new PostHogErrorSink(Promise.resolve(client));
    await tick();
    const reporter = reporterWith([sink]);
    const cause = new Error(`no track "${FORBIDDEN.trackName}" for ${FORBIDDEN.email}`);
    const error = new Error(
      `Clip '${FORBIDDEN.clipName}' of "${FORBIDDEN.projectName}" missing from ${FORBIDDEN.assetUrl}/${FORBIDDEN.assetName}?token=${FORBIDDEN.token}`,
      { cause },
    );

    reporter.report(error, { area: "persistence", fatal: true });
    reporter.report(
      { assistant: FORBIDDEN.assistantText },
      { area: "assistant", fatal: false },
    );

    expect(exceptions()).toHaveLength(2);
    const payload = JSON.stringify(exceptions());
    for (const [label, value] of Object.entries(FORBIDDEN)) {
      expect(payload.includes(value), `${label} reached PostHog: ${value}`).toBe(false);
    }
  });

  it("keeps the classification, the level and a stack to symbolicate", () => {
    const [first] = exceptions();
    expect(first.properties).toMatchObject({
      $exception_level: "fatal",
      area: "persistence",
      fatal: true,
    });
    const list = first.properties.$exception_list as {
      type: string;
      stacktrace?: { frames: { filename?: string; lineno?: number }[] };
    }[];
    expect(list[0].type).toBe("Error");
    expect(list[0].stacktrace?.frames.length).toBeGreaterThan(0);
    expect(
      list[0].stacktrace?.frames.some((frame) => typeof frame.lineno === "number"),
    ).toBe(true);
  });
});
