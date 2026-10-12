import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../testing/storage";
import { Analytics } from "./analytics";
import { ConsentStore } from "./consent";
import {
  createPostHogLoader,
  createPostHogTransport,
  INTERNAL_EVENT_PROPERTY,
  POSTHOG_DEFAULT_HOST,
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
  };
  return client;
}

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
  it("turns off everything PostHog would collect by itself", () => {
    const options = postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory");
    expect(options).toMatchObject({
      api_host: POSTHOG_DEFAULT_HOST,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      capture_exceptions: false,
      capture_performance: false,
      disable_surveys: true,
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
    });
  });

  it("keeps identity in memory before consent, and in cookies after", () => {
    expect(postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory").persistence).toBe("memory");
    expect(
      postHogInitOptions(POSTHOG_DEFAULT_HOST, "localStorage+cookie").persistence,
    ).toBe("localStorage+cookie");
  });
});

describe("createPostHogLoader", () => {
  it("initializes the SDK once, with the key and the options above", async () => {
    const client = fakeClient();
    const { sdk, init } = fakeSdk(client);
    const loader = createPostHogLoader({ settings, importSdk: async () => sdk });

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
    const loader = createPostHogLoader({ settings, importSdk: async () => sdk });
    await loader.load("localStorage+cookie");
    expect(init.mock.calls[0][1]).toMatchObject({ persistence: "localStorage+cookie" });
  });

  it("resolves null when the SDK cannot load", async () => {
    const loader = createPostHogLoader({
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
    const loader = createPostHogLoader({ settings, importSdk: async () => sdk });
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
    const loader = createPostHogLoader({ settings, importSdk: async () => sdk });
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
    const loader = createPostHogLoader({ settings, importSdk: async () => sdk });
    loader.setCollection(false, "memory");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(init).not.toHaveBeenCalled();
  });

  it("never throws out of a consent change on a throwing client", async () => {
    const client = throwingClient();
    const loader = createPostHogLoader({
      settings,
      importSdk: async () => ({ init: () => client }),
    });
    await loader.load("memory");
    expect(() => loader.setCollection(false, "memory")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
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
        "setPersonProperties",
        "register",
        "identify",
        "capture",
      ]),
    );
  });

  it("maps user properties to person properties, and internal to an event property", async () => {
    const client = fakeClient();
    const transport = createPostHogTransport({ load: async () => client });
    transport.setUserProperties({ account_type: "google", internal: "true" });

    await settled(() =>
      expect(client.calls).toEqual([
        {
          method: "setPersonProperties",
          args: [{ account_type: "google", internal: "true" }],
        },
        { method: "register", args: [{ [INTERNAL_EVENT_PROPERTY]: "true" }] },
      ]),
    );
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

  it("sends a $pageview with the URL of the moment it was asked for", async () => {
    const client = fakeClient();
    const transport = createPostHogTransport({ load: async () => client });
    transport.pageview();
    await settled(() =>
      expect(client.calls).toEqual([
        { method: "capture", args: ["$pageview", { $current_url: location.href }] },
      ]),
    );
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
