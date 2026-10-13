import { describe, expect, it, vi } from "vitest";
import {
  BLOCK_MEDIA_SELECTOR,
  isSessionSampled,
  MASK_CONTENT,
  maskReplayAttribute,
  maskReplayNetworkRequest,
  maskReplayText,
  REPLAY_SESSION_SAMPLE_RATE,
} from "../monitoring/replayPrivacy";
import { scrubPostHogEvent } from "../monitoring/scrub";
import { createManualClock } from "../shared/clock";
import { createRouteTracker } from "../telemetry";
import { memoryStorage } from "../testing/storage";
import { Analytics } from "./analytics";
import { ConsentStore } from "./consent";
import {
  createPostHogLoader,
  createPostHogTransport,
  INTERNAL_EVENT_PROPERTY,
  POSTHOG_DEFAULT_HOST,
  POSTHOG_SESSION_RECORDING,
  type PostHogClient,
  type PostHogSdk,
  postHogInitOptions,
  postHogSettings,
} from "./posthogTransport";

/**
 * The PostHog transport against a fake `posthog-js` (GRV-106). The real SDK
 * never loads in a unit test: `createPostHogLoader` takes the import as an
 * option, and `createPostHogTransport` takes the resolved client.
 */

function fakeClient(): PostHogClient & {
  calls: { method: string; args: unknown[] }[];
  optedOut: boolean;
  sessionId: string;
  sessionListeners: ((sessionId: string) => void)[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const client = {
    calls,
    optedOut: false,
    capture: record("capture"),
    identify: record("identify"),
    reset: record("reset"),
    setPersonProperties: record("setPersonProperties"),
    register: record("register"),
    set_config: record("set_config"),
    opt_out_capturing() {
      calls.push({ method: "opt_out_capturing", args: [] });
      client.optedOut = true;
    },
    opt_in_capturing(...args: unknown[]) {
      calls.push({ method: "opt_in_capturing", args });
      client.optedOut = false;
    },
    has_opted_out_capturing() {
      return client.optedOut;
    },
    captureException: record("captureException"),
    sessionId: "session-1",
    get_session_id() {
      return client.sessionId;
    },
    sessionListeners: [] as ((sessionId: string) => void)[],
    onSessionId(listener: (sessionId: string) => void) {
      client.sessionListeners.push(listener);
      return () => {};
    },
    startSessionRecording: record("startSessionRecording"),
    stopSessionRecording: record("stopSessionRecording"),
  };
  return client;
}

/** Extensions the loader imports beside the SDK, stood in for. */
const noExtensions = {
  importRecorder: async () => {},
  importWebVitals: async () => {},
};

/** A client whose every method throws, as a blocked or broken SDK might. */
function throwingClient(): PostHogClient {
  const fail = () => {
    throw new Error("posthog blocked");
  };
  return {
    capture: fail,
    identify: fail,
    reset: fail,
    setPersonProperties: fail,
    register: fail,
    opt_out_capturing: fail,
    opt_in_capturing: fail,
    has_opted_out_capturing: fail,
    set_config: fail,
    captureException: fail,
    get_session_id: fail,
    onSessionId: fail,
    startSessionRecording: fail,
    stopSessionRecording: fail,
  };
}

function settled(assertion: () => void) {
  return vi.waitFor(assertion, { timeout: 2_000 });
}

const settings = { key: "phc_test", host: POSTHOG_DEFAULT_HOST };

function fakeSdk(client: PostHogClient | undefined) {
  const init = vi.fn((_key: string, _config: unknown) => client);
  const sdk: PostHogSdk = { init };
  return { sdk, init };
}

describe("postHogSettings", () => {
  it("is null without a key, so the app runs on noopTransport", () => {
    expect(postHogSettings({})).toBeNull();
    expect(postHogSettings({ VITE_POSTHOG_KEY: "  " })).toBeNull();
  });

  it("defaults the host to PostHog's EU region", () => {
    expect(postHogSettings({ VITE_POSTHOG_KEY: "phc_abc" })).toEqual({
      key: "phc_abc",
      host: "https://eu.i.posthog.com",
    });
    expect(
      postHogSettings({
        VITE_POSTHOG_KEY: "phc_abc",
        VITE_POSTHOG_HOST: "https://us.i.posthog.com",
      })?.host,
    ).toBe("https://us.i.posthog.com");
  });
});

describe("init options", () => {
  it("turns off everything PostHog would collect by itself, bar what GRV-120 turned on", () => {
    const options = postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory");
    expect(options).toMatchObject({
      api_host: POSTHOG_DEFAULT_HOST,
      autocapture: false,
      capture_pageview: false,
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      disable_external_dependency_loading: true,
    });
  });

  it("reads the project's remote config, which is what lets replay start", () => {
    // `advanced_disable_flags` would skip the config request along with the
    // flags, and the recorder never starts without the project's config.
    expect(postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory")).not.toHaveProperty(
      "advanced_disable_flags",
    );
  });

  it("sends a $pageleave, so time on page, scroll depth and bounce rate work", () => {
    expect(postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory").capture_pageleave).toBe(
      true,
    );
  });

  it("captures web vitals and network timing, with the small web-vitals build", () => {
    expect(
      postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory").capture_performance,
    ).toEqual({
      web_vitals: true,
      network_timing: true,
      web_vitals_attribution: false,
    });
  });

  it("keeps exception autocapture off, so every report goes through the boundary", () => {
    expect(postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory").capture_exceptions).toBe(
      false,
    );
  });

  it("scrubs every event on its way out", () => {
    const options = postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory");
    const hostile = {
      uuid: "u",
      event: "$exception",
      properties: { $exception_list: [{ type: "Error", value: 'Clip "Chorus Riff"' }] },
    };
    const beforeSend = options.before_send as (event: typeof hostile) => unknown;
    expect(beforeSend(hostile)).toEqual(scrubPostHogEvent(hostile));
    expect(JSON.stringify(beforeSend(hostile))).not.toContain("Chorus Riff");
  });

  it("starts with recording disabled; the loader starts it for a sampled session", () => {
    expect(
      postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory").disable_session_recording,
    ).toBe(true);
  });

  it("never records the console", () => {
    expect(
      postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory").enable_recording_console_log,
    ).toBe(false);
  });

  it("keeps identity in memory before consent, and in cookies after", () => {
    expect(postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory").persistence).toBe("memory");
    expect(
      postHogInitOptions(POSTHOG_DEFAULT_HOST, "localStorage+cookie").persistence,
    ).toBe("localStorage+cookie");
  });
});

describe("session recording options (ADR 0002, ADR 0003, ADR 0011 decision 2)", () => {
  const recording = postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory").session_recording;

  it("hands the SDK the one recording configuration this module declares", () => {
    expect(recording).toBe(POSTHOG_SESSION_RECORDING);
  });

  it("masks all text and every input, with the component class honoured too", () => {
    expect(recording).toMatchObject({
      maskTextSelector: "*",
      maskTextFn: maskReplayText,
      maskTextClass: MASK_CONTENT,
      maskAllInputs: true,
    });
  });

  it("masks name-bearing attributes and URL query strings", () => {
    expect(recording?.maskAttributeFn).toBe(maskReplayAttribute);
  });

  it("blocks media", () => {
    expect(recording?.blockSelector).toBe(BLOCK_MEDIA_SELECTOR);
  });

  it("records canvas, so the arrangement and piano roll are visible (ADR 0003)", () => {
    expect(recording?.captureCanvas).toMatchObject({ recordCanvas: true });
  });

  it("records network timing without headers or bodies, and masks every URL", () => {
    expect(recording).toMatchObject({ recordHeaders: false, recordBody: false });
    const request = {
      name: "https://firebasestorage.googleapis.com/v0/b/b/o/users%2Fu1%2Fkick.wav?token=t",
      requestBody: "body",
    };
    expect(recording?.maskCapturedNetworkRequestFn?.(request as never)).toEqual(
      maskReplayNetworkRequest(request),
    );
  });

  it("samples at the replay rate", () => {
    expect(recording?.sampleRate).toBe(REPLAY_SESSION_SAMPLE_RATE);
  });
});

describe("createPostHogLoader", () => {
  it("initializes the SDK once, with the key and the options above", async () => {
    const client = fakeClient();
    const { sdk, init } = fakeSdk(client);
    const loader = createPostHogLoader({
      settings,
      ...noExtensions,
      importSdk: async () => sdk,
    });

    expect(await loader.load("memory")).toBe(client);
    expect(await loader.load("localStorage+cookie")).toBe(client);

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      "phc_test",
      postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory"),
    );
  });

  it("uses cookie persistence when consent has been granted", async () => {
    const { sdk, init } = fakeSdk(fakeClient());
    const loader = createPostHogLoader({
      settings,
      ...noExtensions,
      importSdk: async () => sdk,
    });
    await loader.load("localStorage+cookie");
    expect(init.mock.calls[0][1]).toMatchObject({ persistence: "localStorage+cookie" });
  });

  it("resolves null when the SDK cannot load", async () => {
    const loader = createPostHogLoader({
      ...noExtensions,
      settings,
      importSdk: async () => {
        throw new Error("blocked by an ad blocker");
      },
    });
    expect(await loader.load("memory")).toBeNull();
  });

  it("opts back in a client PostHog remembers as opted out, without an event", async () => {
    const client = fakeClient();
    client.optedOut = true;
    const { sdk } = fakeSdk(client);
    const loader = createPostHogLoader({
      settings,
      ...noExtensions,
      importSdk: async () => sdk,
    });
    await loader.load("memory");
    expect(client.optedOut).toBe(false);
    expect(client.calls).toContainEqual({
      method: "opt_in_capturing",
      args: [{ captureEventName: false }],
    });
  });

  it("calls opt_out_capturing when collection is switched off at runtime", async () => {
    const client = fakeClient();
    const { sdk } = fakeSdk(client);
    const loader = createPostHogLoader({
      settings,
      ...noExtensions,
      importSdk: async () => sdk,
    });
    await loader.load("memory");

    loader.setCollection(false, "memory");
    await settled(() => expect(client.optedOut).toBe(true));

    loader.setCollection(true, "localStorage+cookie");
    await settled(() => expect(client.optedOut).toBe(false));
    expect(client.calls).toContainEqual({
      method: "set_config",
      args: [{ persistence: "localStorage+cookie" }],
    });
  });

  it("never loads the SDK just to switch it off", async () => {
    const { sdk, init } = fakeSdk(fakeClient());
    const loader = createPostHogLoader({
      settings,
      ...noExtensions,
      importSdk: async () => sdk,
    });
    loader.setCollection(false, "memory");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(init).not.toHaveBeenCalled();
  });

  it("never throws out of a consent change on a throwing client", async () => {
    const client = throwingClient();
    const loader = createPostHogLoader({
      ...noExtensions,
      settings,
      importSdk: async () => ({ init: () => client }),
    });
    await loader.load("memory");
    expect(() => loader.setCollection(false, "memory")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("hands its client to whoever waits for it, once loaded", async () => {
    const client = fakeClient();
    const { sdk } = fakeSdk(client);
    const loader = createPostHogLoader({
      settings,
      ...noExtensions,
      importSdk: async () => sdk,
    });
    let resolved: unknown = "pending";
    void loader.client.then((value) => {
      resolved = value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe("pending");

    await loader.load("memory");
    await settled(() => expect(resolved).toBe(client));
  });

  it("installs the web-vitals code before the SDK starts, so nothing is fetched", async () => {
    const order: string[] = [];
    const client = fakeClient();
    const loader = createPostHogLoader({
      settings,
      importRecorder: async () => {},
      importWebVitals: async () => void order.push("web-vitals"),
      importSdk: async () => ({
        init: () => {
          order.push("init");
          return client;
        },
      }),
    });
    await loader.load("memory");
    expect(order).toEqual(["web-vitals", "init"]);
  });

  it("still starts the SDK when the web-vitals code cannot load", async () => {
    const client = fakeClient();
    const { sdk } = fakeSdk(client);
    const loader = createPostHogLoader({
      settings,
      importRecorder: async () => {},
      importWebVitals: async () => {
        throw new Error("chunk failed");
      },
      importSdk: async () => sdk,
    });
    expect(await loader.load("memory")).toBe(client);
  });
});

/** A session ID in, and one out of, the replay sample. */
function sessionIds() {
  const ids = Array.from({ length: 500 }, (_, i) => `session-${i}`);
  const sampled = ids.find((id) => isSessionSampled(id, REPLAY_SESSION_SAMPLE_RATE));
  const unsampled = ids.find((id) => !isSessionSampled(id, REPLAY_SESSION_SAMPLE_RATE));
  if (!sampled || !unsampled)
    throw new Error("no session IDs on both sides of the sample");
  return { sampled, unsampled };
}

describe("session replay through the loader (ADR 0011 decision 2)", () => {
  function setup(sessionId: string, replayAllowed = { value: true }) {
    const client = fakeClient();
    client.sessionId = sessionId;
    const { sdk } = fakeSdk(client);
    const importRecorder = vi.fn(async () => {});
    const loader = createPostHogLoader({
      settings,
      importSdk: async () => sdk,
      importRecorder,
      importWebVitals: async () => {},
    });
    const load = () =>
      loader.load("memory", { sessionReplayAllowed: () => replayAllowed.value });
    const methods = () => client.calls.map((call) => call.method);
    return { client, loader, importRecorder, load, methods, replayAllowed };
  }

  it("loads the recorder and starts recording for a sampled session", async () => {
    const { importRecorder, load, methods } = setup(sessionIds().sampled);
    await load();
    await settled(() => expect(methods()).toContain("startSessionRecording"));
    expect(importRecorder).toHaveBeenCalledTimes(1);
  });

  it("never loads the recorder for a session outside the sample", async () => {
    const { importRecorder, load, methods } = setup(sessionIds().unsampled);
    await load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(importRecorder).not.toHaveBeenCalled();
    expect(methods()).not.toContain("startSessionRecording");
  });

  it("records nothing for a session that declined replay", async () => {
    const { importRecorder, load, methods } = setup(sessionIds().sampled, {
      value: false,
    });
    await load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(importRecorder).not.toHaveBeenCalled();
    expect(methods()).not.toContain("startSessionRecording");
  });

  it("does not start a recording whose consent was withdrawn while the recorder loaded", async () => {
    const replayAllowed = { value: true };
    const { importRecorder, load, methods } = setup(sessionIds().sampled, replayAllowed);
    let finish: () => void = () => {};
    importRecorder.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await load();
    replayAllowed.value = false;
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(methods()).not.toContain("startSessionRecording");
  });

  it("starts recording when a later session lands in the sample", async () => {
    const { sampled, unsampled } = sessionIds();
    const { client, importRecorder, load, methods } = setup(unsampled);
    await load();
    expect(importRecorder).not.toHaveBeenCalled();

    client.sessionId = sampled;
    for (const listener of client.sessionListeners) listener(sampled);

    await settled(() => expect(methods()).toContain("startSessionRecording"));
  });

  it("stops an in-flight recording when replay is withdrawn, and starts no other", async () => {
    const { sampled } = sessionIds();
    const { client, loader, load, methods } = setup(sampled);
    await load();
    await settled(() => expect(methods()).toContain("startSessionRecording"));

    loader.stopSessionRecording();
    await settled(() => expect(methods()).toContain("stopSessionRecording"));

    const starts = methods().filter(
      (method) => method === "startSessionRecording",
    ).length;
    for (const listener of client.sessionListeners) listener(sampled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(methods().filter((method) => method === "startSessionRecording")).toHaveLength(
      starts,
    );
    // Analytics keeps running.
    expect(methods()).not.toContain("opt_out_capturing");
  });

  it("keeps a session unrecorded, not broken, when the recorder cannot load", async () => {
    const { importRecorder, load, methods } = setup(sessionIds().sampled);
    importRecorder.mockRejectedValue(new Error("chunk failed"));
    await expect(load()).resolves.not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(methods()).not.toContain("startSessionRecording");
  });

  it("never loads the SDK just to stop a recording", () => {
    const { sdk, init } = fakeSdk(fakeClient());
    const loader = createPostHogLoader({
      settings,
      ...noExtensions,
      importSdk: async () => sdk,
    });
    loader.stopSessionRecording();
    expect(init).not.toHaveBeenCalled();
  });
});

describe("createPostHogTransport", () => {
  it("passes catalog events through unchanged", async () => {
    const client = fakeClient();
    const transport = createPostHogTransport({ load: async () => client });
    await settled(() => expect(client.calls).toEqual([]));

    transport.logEvent("clip_edited", { editor: "piano_roll", surface: "editor" });

    await settled(() =>
      expect(client.calls).toEqual([
        {
          method: "capture",
          args: ["clip_edited", { editor: "piano_roll", surface: "editor" }],
        },
      ]),
    );
  });

  it("queues calls until the client resolves, in order", async () => {
    const client = fakeClient();
    let resolve: (value: PostHogClient) => void = () => {};
    const transport = createPostHogTransport({
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });

    transport.setUserProperties({ account_type: "google", internal: "false" });
    transport.identify("uid_123");
    transport.logEvent("app_opened", { surface: "dashboard" });
    expect(client.calls).toEqual([]);

    resolve(client);
    await settled(() =>
      expect(client.calls.map((call) => call.method)).toEqual([
        "register",
        "identify",
        "setPersonProperties",
        "capture",
      ]),
    );
  });

  it("stamps a queued event with the time it was logged, not the time it was sent", async () => {
    const client = fakeClient();
    const clock = createManualClock(1_000);
    let resolve: (value: PostHogClient) => void = () => {};
    const transport = createPostHogTransport({
      clock,
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });

    transport.logEvent("app_opened", { surface: "dashboard" });
    clock.advance(5_000);
    resolve(client);

    await settled(() =>
      expect(client.calls).toEqual([
        {
          method: "capture",
          args: ["app_opened", { surface: "dashboard" }, { timestamp: new Date(1_000) }],
        },
      ]),
    );
  });

  it("only registers the internal flag for an anonymous visitor (identified_only)", async () => {
    const client = fakeClient();
    const transport = createPostHogTransport({ load: async () => client });
    transport.setUserProperties({ account_type: "unknown", internal: "true" });

    await settled(() =>
      expect(client.calls).toEqual([
        { method: "register", args: [{ [INTERNAL_EVENT_PROPERTY]: "true" }] },
      ]),
    );
  });

  it("sends person properties once the visitor is identified", async () => {
    const client = fakeClient();
    const transport = createPostHogTransport({ load: async () => client });
    await settled(() => expect(client.calls).toEqual([]));

    transport.setUserProperties({ account_type: "google", internal: "false" });
    transport.identify("uid_123");
    transport.setUserProperties({ account_type: "google", internal: "true" });
    transport.resetIdentity();
    transport.setUserProperties({ account_type: "unknown", internal: "true" });

    expect(client.calls).toEqual([
      { method: "register", args: [{ [INTERNAL_EVENT_PROPERTY]: "false" }] },
      { method: "identify", args: ["uid_123"] },
      {
        method: "setPersonProperties",
        args: [{ account_type: "google", internal: "false" }],
      },
      { method: "register", args: [{ [INTERNAL_EVENT_PROPERTY]: "true" }] },
      {
        method: "setPersonProperties",
        args: [{ account_type: "google", internal: "true" }],
      },
      { method: "reset", args: [] },
      { method: "register", args: [{ [INTERNAL_EVENT_PROPERTY]: "true" }] },
    ]);
  });

  it("identifies by the UID it is given and nothing else", async () => {
    const client = fakeClient();
    const transport = createPostHogTransport({ load: async () => client });
    transport.identify("uid_123");

    await settled(() =>
      expect(client.calls).toEqual([{ method: "identify", args: ["uid_123"] }]),
    );
  });

  it("resets the identity on sign-out", async () => {
    const client = fakeClient();
    const transport = createPostHogTransport({ load: async () => client });
    transport.resetIdentity();
    await settled(() => expect(client.calls).toEqual([{ method: "reset", args: [] }]));
  });

  it("sends a $pageview with the location of the moment it was asked for", async () => {
    const client = fakeClient();
    const transport = createPostHogTransport({ load: async () => client });
    await settled(() => expect(client.calls).toEqual([]));
    transport.pageview();
    expect(client.calls).toEqual([
      {
        method: "capture",
        args: [
          "$pageview",
          {
            $current_url: location.href,
            $host: location.host,
            $pathname: location.pathname,
          },
        ],
      },
    ]);
  });

  it("keeps a queued $pageview's path, not the one the SDK loaded on", async () => {
    const client = fakeClient();
    let resolve: (value: PostHogClient) => void = () => {};
    const transport = createPostHogTransport({
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const entry = location.pathname;
    transport.pageview();
    history.pushState(null, "", "/projects");
    try {
      resolve(client);
      await settled(() => expect(client.calls).toHaveLength(1));
      expect(client.calls[0]?.args[1]).toMatchObject({ $pathname: entry });
    } finally {
      history.pushState(null, "", entry);
    }
  });

  it("drops its queue and aborts its load when disposed", async () => {
    const client = fakeClient();
    let resolve: (value: PostHogClient) => void = () => {};
    let signal: AbortSignal | undefined;
    const transport = createPostHogTransport({
      load: (abort) => {
        signal = abort;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    transport.logEvent("app_opened", { surface: "dashboard" });
    transport.dispose?.();
    expect(signal?.aborted).toBe(true);

    resolve(client);
    await new Promise((done) => setTimeout(done, 0));
    transport.logEvent("app_opened", { surface: "dashboard" });
    expect(client.calls).toEqual([]);
  });

  it("caps the queue so a client that never resolves cannot grow it forever", async () => {
    const client = fakeClient();
    let resolve: (value: PostHogClient) => void = () => {};
    const transport = createPostHogTransport({
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    for (let index = 0; index < 50; index += 1) {
      transport.logEvent("app_opened", { surface: "dashboard" });
    }
    resolve(client);
    await settled(() => expect(client.calls).toHaveLength(20));
  });

  it("discards everything when the client resolves null", async () => {
    const transport = createPostHogTransport({ load: async () => null });
    transport.logEvent("app_opened", { surface: "dashboard" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() =>
      transport.logEvent("app_opened", { surface: "dashboard" }),
    ).not.toThrow();
  });

  it("never throws, whether loading rejects or the client throws", async () => {
    const rejecting = createPostHogTransport({
      load: async () => {
        throw new Error("blocked");
      },
    });
    const throwing = createPostHogTransport({ load: async () => throwingClient() });
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const transport of [rejecting, throwing]) {
      expect(() => {
        transport.logEvent("app_opened", { surface: "dashboard" });
        transport.setUserProperties({ internal: "true" });
        transport.identify("uid_123");
        transport.resetIdentity();
        transport.pageview();
      }).not.toThrow();
    }
  });

  it("is never called for an opted-out session, through the boundary", async () => {
    const consent = new ConsentStore(memoryStorage());
    consent.optOut();
    const client = fakeClient();
    const load = vi.fn(async () => client);
    const analytics = new Analytics({
      transport: createPostHogTransport({ load }),
      consent,
      storage: memoryStorage(),
    });
    analytics.log("app_opened");
    analytics.setUserId("uid_123");
    analytics.pageview();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.calls).toEqual([]);
  });
});

describe("$pageview through the real SDK (GRV-120, Web Analytics)", () => {
  // The real `posthog-js` client with the real init options, and a recorder
  // appended after the transport's own `before_send` that keeps what would
  // have been sent and sends nothing.
  it("carries the SDK's session ID, and fires once per new pathname", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const { default: posthog } = await import("posthog-js");
      const options = postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory");
      const sent: { event: string; properties: Record<string, unknown> }[] = [];
      const client = posthog.init("phc_pageview_test", {
        ...options,
        before_send: [
          options.before_send as never,
          (event) => {
            if (event) sent.push(event as never);
            return null;
          },
        ],
      });
      if (!client) throw new Error("posthog-js did not initialize");

      const consent = new ConsentStore(memoryStorage());
      const boundary = new Analytics({
        transport: createPostHogTransport({ load: async () => client }),
        consent,
        storage: memoryStorage(),
      });
      const track = createRouteTracker(boundary);
      const telemetry = { setSurface: () => {} };
      const visit = (path: string) => {
        history.pushState({}, "", path);
        track(path, telemetry);
      };

      visit("/projects");
      visit("/projects");
      visit("/projects/prj_abc123");

      await settled(() =>
        expect(sent.filter((event) => event.event === "$pageview")).toHaveLength(2),
      );
      const views = sent.filter((event) => event.event === "$pageview");
      expect(views.map((view) => view.properties.$pathname)).toEqual([
        "/projects",
        "/projects/prj_abc123",
      ]);
      for (const view of views) {
        expect(view.properties.$session_id).toBe(client.get_session_id());
        expect(view.properties.$session_id).toEqual(expect.any(String));
      }
    } finally {
      globalThis.fetch = realFetch;
      history.pushState({}, "", "/");
    }
  });
});
