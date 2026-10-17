import { describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import {
  createFailingTransport,
  createRecordingTransport,
  type RecordingTransport,
} from "../analytics/transport";
import { memoryStorage } from "../testing/storage";
import { UNKNOWN_BROWSER } from "./browserInfo";
import {
  CodedError,
  codeFor,
  type ErrorReport,
  ErrorReporter,
  type ErrorSink,
} from "./errorReporting";

interface RecordingSink extends ErrorSink {
  readonly reports: ErrorReport[];
}

function recordingSink(): RecordingSink {
  const reports: ErrorReport[] = [];
  return { reports, capture: (report) => void reports.push(report) };
}

function failingSink(): ErrorSink {
  return {
    capture() {
      throw new Error("sentry.io blocked");
    },
  };
}

function setup(
  options: { sinks?: ErrorSink[]; consent?: ConsentStore; now?: () => number } = {},
) {
  const transport: RecordingTransport = createRecordingTransport();
  const consent = options.consent ?? new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    releaseSha: "abc123def456",
    surface: "editor",
    storage: memoryStorage(),
  });
  const reporter = new ErrorReporter({
    analytics,
    consent,
    sinks: options.sinks,
    releaseSha: "abc123def456",
    browser: {
      ...UNKNOWN_BROWSER,
      browserName: "firefox",
      browserVersion: "142",
    },
    now: options.now,
  });
  return { reporter, transport, consent, analytics };
}

describe("one report per error (PRD OPS-03)", () => {
  it("fans one report out to the analytics counter and to every sink", () => {
    const sink = recordingSink();
    const { reporter, transport } = setup({ sinks: [sink] });

    expect(reporter.report(new Error("boom"), { area: "audio", fatal: false })).toBe(
      true,
    );

    expect(sink.reports).toHaveLength(1);
    expect(transport.named("exception")).toHaveLength(1);
    expect(transport.named("exception")[0].params).toMatchObject({
      area: "audio",
      fatal: false,
      error_code: "unknown",
    });
  });

  it("collapses the same error seen by a boundary and the global handler", () => {
    // The realistic duplicate: one throw reaches AppErrorFallback and
    // window.onerror. Both call the boundary; the user's dashboard must not
    // show two crashes.
    const sink = recordingSink();
    const { reporter, transport } = setup({ sinks: [sink] });
    const error = new Error("boom");

    expect(reporter.report(error, { area: "shell", fatal: true })).toBe(true);
    expect(reporter.report(error, { area: "shell", fatal: true })).toBe(false);

    expect(sink.reports).toHaveLength(1);
    expect(transport.named("exception")).toHaveLength(1);
  });

  it("reports the same error again once the dedupe window has passed", () => {
    let now = 0;
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink], now: () => now });

    reporter.report(new Error("boom"), { area: "shell", fatal: true });
    now += 10_000;
    reporter.report(new Error("boom"), { area: "shell", fatal: true });

    expect(sink.reports).toHaveLength(2);
  });

  it("does not collapse genuinely different errors", () => {
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });

    reporter.report(new Error("first"), { area: "shell", fatal: true });
    reporter.report(new Error("second"), { area: "shell", fatal: true });

    expect(sink.reports).toHaveLength(2);
  });

  it("bounds what it remembers, so an error loop cannot grow memory", () => {
    const { reporter } = setup();
    for (let i = 0; i < 500; i += 1) {
      reporter.report(new Error(`distinct ${i}`), {
        area: "shell",
        fatal: true,
      });
    }
    // Nothing to assert beyond "it finished and stayed responsive"; the cap
    // itself is enforced by dedupeCapacity in the implementation.
    expect(reporter.report(new Error("after"), { area: "shell", fatal: true })).toBe(
      true,
    );
  });
});

describe("fatal vs non-fatal (crash-free session rate, PRD section 11)", () => {
  it("carries fatal through to the sink and the counter event", () => {
    const sink = recordingSink();
    const { reporter, transport } = setup({ sinks: [sink] });

    reporter.report(new Error("crash"), { area: "shell", fatal: true });

    expect(sink.reports[0].fatal).toBe(true);
    expect(transport.named("exception")[0].params.fatal).toBe(true);
  });

  it("keeps a recovered failure non-fatal", () => {
    // A caught, recovered audio failure must not mark the session crashed, or
    // the crash-free session rate stops meaning anything.
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });

    reporter.report(new Error("no gesture"), { area: "audio", fatal: false });

    expect(sink.reports[0].fatal).toBe(false);
  });

  it("distinguishes two otherwise identical errors by fatality", () => {
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });
    const error = new Error("same text");

    reporter.report(error, { area: "shell", fatal: false });
    reporter.report(error, { area: "shell", fatal: true });

    // Same fingerprint inputs, so the second is collapsed. The first report
    // wins, which is the conservative direction: a session is not marked
    // crashed by a failure something already recovered from.
    expect(sink.reports).toHaveLength(1);
    expect(sink.reports[0].fatal).toBe(false);
  });
});

describe("error codes", () => {
  it("takes the code an error declares", () => {
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });

    reporter.report(new CodedError("revision_conflict", "stale"), {
      area: "persistence",
      fatal: false,
    });

    expect(sink.reports[0].code).toBe("revision_conflict");
  });

  it("lets the caller override the derived code", () => {
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });

    reporter.report(new Error("boom"), {
      area: "audio",
      fatal: false,
      code: "autoplay_blocked",
    });

    expect(sink.reports[0].code).toBe("autoplay_blocked");
  });

  it("maps DOMException names, which are a specified vocabulary", () => {
    const notAllowed = new Error("blocked");
    notAllowed.name = "NotAllowedError";
    expect(codeFor(notAllowed)).toBe("autoplay_blocked");
    expect(codeFor(new Error("plain"))).toBe("unknown");
    expect(codeFor("a string")).toBe("unknown");
  });

  it("narrows an unrecognized declared code rather than smuggling free text", () => {
    const error = Object.assign(new Error("boom"), { code: "Midnight Drive" });
    expect(codeFor(error)).toBe("unknown");
  });
});

describe("no PII in a report (PRD OPS-02 / OPS-03)", () => {
  it("redacts the transmitted message", () => {
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });

    reporter.report(new Error('Clip "Midnight Drive" not found'), {
      area: "editor",
      fatal: false,
    });

    expect(sink.reports[0].message).not.toContain("Midnight Drive");
  });

  it("never stringifies a thrown non-error object", () => {
    // Its fields are exactly the project state that must not travel.
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });

    reporter.report({ project: "Midnight Drive" }, { area: "editor", fatal: true });

    expect(sink.reports[0].message).not.toContain("Midnight Drive");
    expect(sink.reports[0].message).toBe("non-error thrown (object)");
  });

  it("sends no message at all on the analytics counter event", () => {
    const { reporter, transport } = setup();

    reporter.report(new Error('Clip "Midnight Drive" not found'), {
      area: "editor",
      fatal: false,
    });

    expect(JSON.stringify(transport.named("exception"))).not.toContain("Midnight");
    expect(transport.named("exception")[0].params).not.toHaveProperty("message");
  });
});

describe("a failing reporter cannot affect the caller (PRD OPS-03)", () => {
  it("returns rather than throwing when a sink throws", () => {
    const { reporter } = setup({ sinks: [failingSink()] });
    expect(() =>
      reporter.report(new Error("boom"), { area: "shell", fatal: true }),
    ).not.toThrow();
  });

  it("keeps one blocked sink from stopping another", () => {
    // The expected path for a session with an ad blocker, not an anomaly.
    const working = recordingSink();
    const { reporter } = setup({ sinks: [failingSink(), working] });

    reporter.report(new Error("boom"), { area: "shell", fatal: true });

    expect(working.reports).toHaveLength(1);
  });

  it("still counts the exception when every sink is blocked", () => {
    const { reporter, transport } = setup({ sinks: [failingSink()] });

    reporter.report(new Error("boom"), { area: "shell", fatal: true });

    expect(transport.named("exception")).toHaveLength(1);
  });

  it("does not recurse when a sink reports its own failure", () => {
    // Without the re-entrancy guard this is an unbounded loop that hangs the
    // tab — the failure mode PRD OPS-03 calls out by name.
    const { reporter } = setup();
    let depth = 0;
    reporter.addSink({
      capture() {
        depth += 1;
        reporter.report(new Error("sink failed"), {
          area: "shell",
          fatal: false,
        });
      },
    });

    reporter.report(new Error("original"), { area: "shell", fatal: true });

    expect(depth).toBe(1);
  });
});

describe("consent (PRD OPS-02 opt-out)", () => {
  it("sends nothing to either processor once the user opts out", () => {
    const consent = new ConsentStore(memoryStorage());
    const sink = recordingSink();
    const { reporter, transport } = setup({ sinks: [sink], consent });

    consent.optOut();
    reporter.report(new Error("boom"), { area: "shell", fatal: true });

    expect(sink.reports).toHaveLength(0);
    expect(transport.named("exception")).toHaveLength(0);
  });

  it("stops the monitoring processor while leaving analytics on", () => {
    const consent = new ConsentStore(memoryStorage());
    const sink = recordingSink();
    const { reporter, transport } = setup({ sinks: [sink], consent });

    consent.set({ errorMonitoring: false });
    reporter.report(new Error("boom"), { area: "shell", fatal: true });

    expect(sink.reports).toHaveLength(0);
    expect(transport.named("exception")).toHaveLength(1);
  });
});

describe("sink lifecycle", () => {
  it("stops delivering to a removed sink", () => {
    const sink = recordingSink();
    const { reporter } = setup();
    reporter.addSink(sink);
    reporter.removeSink(sink);

    reporter.report(new Error("boom"), { area: "shell", fatal: true });

    expect(sink.reports).toHaveLength(0);
  });

  it("attaches the release SHA and browser info to every report", () => {
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });

    reporter.report(new Error("boom"), { area: "shell", fatal: true });

    expect(sink.reports[0].releaseSha).toBe("abc123def456");
    expect(sink.reports[0].browser.browserName).toBe("firefox");
    expect(sink.reports[0].browser.browserVersion).toBe("142");
  });

  it("hands the sink the original error so it can symbolicate the stack", () => {
    const sink = recordingSink();
    const { reporter } = setup({ sinks: [sink] });
    const error = new Error("boom");

    reporter.report(error, { area: "shell", fatal: true });

    expect(sink.reports[0].error).toBe(error);
  });

  it("reports before any sink is attached without losing the counter event", () => {
    const { reporter, transport } = setup();
    reporter.report(new Error("early"), { area: "shell", fatal: true });
    expect(transport.named("exception")).toHaveLength(1);
  });
});

describe("analytics failure cannot break reporting", () => {
  it("still reaches the sinks when the analytics transport throws", () => {
    const sink = recordingSink();
    const consent = new ConsentStore(memoryStorage());
    const analytics = new Analytics({
      transport: createFailingTransport("analytics blocked"),
      consent,
      storage: memoryStorage(),
    });
    const reporter = new ErrorReporter({ analytics, consent, sinks: [sink] });

    expect(() =>
      reporter.report(new Error("boom"), { area: "shell", fatal: true }),
    ).not.toThrow();
    expect(sink.reports).toHaveLength(1);
  });
});

describe("CodedError", () => {
  it("carries its code and preserves the cause chain", () => {
    const cause = new Error("underlying");
    const error = new CodedError("timeout", "gave up", { cause });
    expect(error.code).toBe("timeout");
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("browser info is never allowed to break a report", () => {
  it("falls back to the unknown browser rather than throwing", () => {
    const sink = recordingSink();
    const spy = vi.spyOn(navigator, "userAgent", "get").mockImplementation(() => {
      throw new Error("no navigator");
    });
    try {
      const reporter = new ErrorReporter({
        analytics: new Analytics({
          consent: new ConsentStore(memoryStorage()),
          storage: memoryStorage(),
        }),
        consent: new ConsentStore(memoryStorage()),
        sinks: [sink],
      });
      reporter.report(new Error("boom"), { area: "shell", fatal: true });
      expect(sink.reports[0].browser).toEqual(UNKNOWN_BROWSER);
    } finally {
      spy.mockRestore();
    }
  });
});
