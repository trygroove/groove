import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostileStorage, memoryStorage } from "../testing/storage";
import { Analytics, type AnalyticsOptions } from "./analytics";
import { ConsentStore } from "./consent";
import { packAnalyticsIdentity } from "./packIdentity";
import {
  type AnalyticsTransport,
  createFailingTransport,
  createRecordingTransport,
  type RecordingTransport,
} from "./transport";

function setup(overrides: AnalyticsOptions = {}) {
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    releaseSha: "abc123def456",
    surface: "editor",
    storage: memoryStorage(),
    ...overrides,
  });
  return { analytics, transport, consent };
}

describe("enrichment (PRD OPS-02)", () => {
  it("attaches the release SHA and surface to every event", () => {
    const { analytics, transport } = setup();
    analytics.log("app_opened");
    expect(transport.events[0]).toEqual({
      name: "app_opened",
      params: { release_sha: "abc123def456", surface: "editor" },
    });
  });

  it("does not let a caller override an automatic parameter", () => {
    const { analytics, transport } = setup();
    // Automatic parameters are not in the payload type; this is the untyped
    // edge the runtime validator guards.
    (analytics.log as (n: string, p: unknown) => void)("app_opened", {
      release_sha: "deadbeef",
      surface: "landing",
    });
    // The event is dropped rather than sent with a forged release.
    expect(transport.events).toHaveLength(0);
  });

  it("follows the surface as the user navigates", () => {
    const { analytics, transport } = setup();
    analytics.setSurface("dashboard");
    analytics.log("app_opened");
    expect(transport.events[0].params.surface).toBe("dashboard");
  });

  it("sets account type and internal traffic as user properties", () => {
    const { analytics, transport } = setup();
    analytics.setAccountType("anonymous");
    analytics.log("app_opened");
    expect(transport.userProperties).toEqual({
      account_type: "anonymous",
      internal: "false",
    });
    // A user property is never smuggled into the event parameters.
    expect(transport.events[0].params).not.toHaveProperty("account_type");
  });

  it("re-sends user properties to a transport swapped in later", () => {
    const { analytics } = setup();
    analytics.setAccountType("registered");
    const replacement = createRecordingTransport();
    analytics.setTransport(replacement);
    expect(replacement.userProperties.account_type).toBe("registered");
  });

  it("marks the session internal when told so, without re-reading storage", () => {
    const { analytics, transport } = setup();
    analytics.setAccountType("registered");
    analytics.setInternalTraffic(true);
    expect(transport.userProperties).toEqual({
      account_type: "registered",
      internal: "true",
    });
    // Internal traffic is a user property, never an event parameter.
    analytics.log("app_opened");
    expect(transport.events[0].params).not.toHaveProperty("internal");
  });
});

describe("validation", () => {
  it("drops an event whose parameter value is not declared", () => {
    const onIssue = vi.fn();
    const { analytics, transport } = setup({ onIssue });
    (analytics.log as (n: string, p: unknown) => void)("clip_edited", {
      editor: "Some Project Name",
      event_count_bucket: "1_4",
    });
    expect(transport.events).toHaveLength(0);
    expect(onIssue).toHaveBeenCalled();
  });

  it("never passes a rejected value to the issue handler", () => {
    const onIssue = vi.fn();
    const { analytics } = setup({ onIssue });
    (analytics.log as (n: string, p: unknown) => void)("clip_edited", {
      editor: "Midnight Drive",
      event_count_bucket: "1_4",
    });
    expect(JSON.stringify(onIssue.mock.calls)).not.toContain("Midnight Drive");
  });
});

describe("consent (PRD OPS-02 opt-out)", () => {
  it("sends nothing once the user opts out", () => {
    const { analytics, transport, consent } = setup();
    consent.optOut();
    analytics.log("app_opened");
    analytics.setAccountType("registered");
    expect(transport.events).toHaveLength(0);
    expect(transport.userProperties).toEqual({});
  });

  it("resumes when consent is granted again", () => {
    const { analytics, transport, consent } = setup();
    consent.optOut();
    analytics.log("app_opened");
    consent.optIn();
    analytics.log("app_opened");
    expect(transport.events).toHaveLength(1);
  });

  it("does not consume a once-only event while opted out", () => {
    // Otherwise opting back in would permanently lose a first-use signal.
    const { analytics, transport, consent } = setup();
    consent.optOut();
    expect(analytics.logFeatureFirstUse("step_editor")).toBe(false);
    consent.optIn();
    expect(analytics.logFeatureFirstUse("step_editor")).toBe(true);
    expect(transport.named("feature_first_use")).toHaveLength(1);
  });
});

describe("identity (GRV-106)", () => {
  it("identifies the signed-in account by its UID", () => {
    const { analytics, transport } = setup();
    analytics.setUserId("uid_123");
    expect(transport.userId).toBe("uid_123");
  });

  it("identifies once per account, not once per call", () => {
    const transport = createRecordingTransport();
    const identify = vi.spyOn(transport, "identify");
    const { analytics } = setup({ transport });
    analytics.setUserId("uid_123");
    analytics.setUserId("uid_123");
    analytics.log("app_opened");
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it("resets on sign-out and sends the person properties again", () => {
    const { analytics, transport } = setup();
    analytics.setUserId("uid_123");
    transport.reset();
    analytics.setUserId(null);
    expect(transport.userId).toBeNull();
    expect(transport.identityResets).toBe(1);
    expect(transport.userProperties).toEqual({
      account_type: "unknown",
      internal: "false",
    });
  });

  it("resets before identifying a different account on the same browser", () => {
    const { analytics, transport } = setup();
    analytics.setUserId("uid_a");
    analytics.setUserId("uid_b");
    expect(transport.identityResets).toBe(1);
    expect(transport.userId).toBe("uid_b");
  });

  it("does not reset for a page that loads signed out", () => {
    const { analytics, transport } = setup();
    analytics.setUserId(null);
    expect(transport.identityResets).toBe(0);
  });

  it("identifies nobody while opted out, and identifies on a new transport after", () => {
    const { analytics, transport, consent } = setup();
    consent.optOut();
    analytics.setUserId("uid_123");
    expect(transport.userId).toBeNull();

    consent.optIn();
    const next = createRecordingTransport();
    analytics.setTransport(next);
    expect(next.userId).toBe("uid_123");
  });
});

describe("page views (GRV-106)", () => {
  it("sends one page view per call", () => {
    const { analytics, transport } = setup();
    analytics.pageview();
    analytics.pageview();
    expect(transport.pageviews).toBe(2);
  });

  it("sends none while opted out", () => {
    const { analytics, transport, consent } = setup();
    consent.optOut();
    analytics.pageview();
    expect(transport.pageviews).toBe(0);
  });

  it("never throws from a failing transport", () => {
    const { analytics } = setup({ transport: createFailingTransport() });
    expect(() => {
      analytics.pageview();
      analytics.setUserId("uid_123");
      analytics.setUserId(null);
    }).not.toThrow();
  });
});

describe("library_pack_added (LOOP-013, LIB-08)", () => {
  // Its call site is the library browser's `addPack` (see
  // `useLibraryBrowser.test.ts`), which is the only place a pack's *published*
  // identity is known. These tests pin the catalog contract: shape,
  // once-per-action, and consent-gating.
  const factoryPack = {
    slug: "core-electronic-drums",
    kind: "factory",
  } as const;
  const thirdPartyPack = {
    slug: "midnight-tape-drums",
    kind: "third-party",
  } as const;

  it("sends exactly one event naming which pack was added", () => {
    const { analytics, transport } = setup();
    analytics.log("library_pack_added", packAnalyticsIdentity(factoryPack));
    expect(transport.named("library_pack_added")).toHaveLength(1);
    expect(transport.events[0].params).toEqual({
      release_sha: "abc123def456",
      surface: "editor",
      pack_kind: "factory",
      pack_id: "core-electronic-drums",
    });
  });

  it("names a third-party pack, so its creator's adoption is reportable", () => {
    const { analytics, transport } = setup();
    analytics.log("library_pack_added", packAnalyticsIdentity(thirdPartyPack));
    expect(transport.events[0].params).toMatchObject({
      pack_kind: "third_party",
      pack_id: "midnight-tape-drums",
    });
  });

  it("fires once per add, not once per render", () => {
    const { analytics, transport } = setup();
    analytics.log("library_pack_added", packAnalyticsIdentity(factoryPack));
    analytics.log("library_pack_added", packAnalyticsIdentity(thirdPartyPack));
    expect(transport.named("library_pack_added")).toHaveLength(2);
  });

  it("drops an event whose pack id is not a published slug", () => {
    // The untyped edge: a caller that reaches past the compiler with a pack's
    // own ID gets the event dropped, not a pack ID delivered to GA4.
    const { analytics, transport } = setup();
    analytics.log("library_pack_added", {
      pack_kind: "user",
      // @ts-expect-error — a raw string is not a checked pack identity.
      pack_id: "pak_SdlN_OazweXrwury0j27Y",
    });
    expect(transport.events).toHaveLength(0);
  });

  it("sends nothing while the user is opted out", () => {
    const { analytics, transport, consent } = setup();
    consent.optOut();
    analytics.log("library_pack_added", packAnalyticsIdentity(factoryPack));
    expect(transport.events).toHaveLength(0);
  });
});

describe("fail-open (PRD OPS-02)", () => {
  it("swallows a throwing transport", () => {
    const { analytics } = setup({ transport: createFailingTransport() });
    expect(() => analytics.log("app_opened")).not.toThrow();
  });

  it("swallows a throwing transport when setting user properties", () => {
    const { analytics } = setup({ transport: createFailingTransport() });
    expect(() => analytics.setAccountType("registered")).not.toThrow();
  });

  it("keeps working when storage is unavailable", () => {
    const { analytics, transport } = setup({ storage: hostileStorage() });
    expect(() => analytics.log("app_opened")).not.toThrow();
    expect(transport.events).toHaveLength(1);
  });

  it("still fires a once-only event exactly once without storage", () => {
    // Degrades from once-per-account to once-per-session rather than
    // once-per-call, which would multiply a first-use measure.
    const { analytics, transport } = setup({ storage: hostileStorage() });
    analytics.logFeatureFirstUse("synth");
    analytics.logFeatureFirstUse("synth");
    expect(transport.named("feature_first_use")).toHaveLength(1);
  });

  it("swallows a throwing issue handler", () => {
    const { analytics } = setup({
      onIssue: () => {
        throw new Error("handler exploded");
      },
    });
    expect(() =>
      (analytics.log as (n: string, p: unknown) => void)("clip_edited", {
        editor: "nope",
      }),
    ).not.toThrow();
  });
});

describe("once-only events (PRD OPS-02)", () => {
  let storage: Storage;
  let transport: RecordingTransport;

  beforeEach(() => {
    storage = memoryStorage();
    transport = createRecordingTransport();
  });

  function make() {
    return new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage,
      surface: "editor",
    });
  }

  it("fires feature_first_use once per feature", () => {
    const analytics = make();
    expect(analytics.logFeatureFirstUse("step_editor")).toBe(true);
    expect(analytics.logFeatureFirstUse("step_editor")).toBe(false);
    expect(transport.named("feature_first_use")).toHaveLength(1);
    expect(transport.events[0].params.feature).toBe("step_editor");
  });

  it("fires once per feature, not once overall", () => {
    const analytics = make();
    analytics.logFeatureFirstUse("step_editor");
    analytics.logFeatureFirstUse("synth");
    expect(transport.named("feature_first_use")).toHaveLength(2);
  });

  it("stays fired across a reload", () => {
    make().logFeatureFirstUse("mixer");
    // A fresh instance over the same storage is what a page reload looks like.
    make().logFeatureFirstUse("mixer");
    expect(transport.named("feature_first_use")).toHaveLength(1);
  });

  it("scopes first_edit per project", () => {
    const analytics = make();
    const payload = {
      command_id: "note.add",
      seconds_since_open_bucket: "0_5s",
    } as const;
    expect(analytics.logOnce("first_edit:prj_a", "first_edit", payload)).toBe(true);
    expect(analytics.logOnce("first_edit:prj_a", "first_edit", payload)).toBe(false);
    expect(analytics.logOnce("first_edit:prj_b", "first_edit", payload)).toBe(true);
    expect(transport.named("first_edit")).toHaveLength(2);
  });
});

describe("type safety (PRD OPS-02: logging an unregistered event is a type error)", () => {
  it("rejects unregistered events, parameters, and values at compile time", () => {
    const { analytics } = setup();

    // @ts-expect-error - "definitely_not_an_event" is not in the catalog.
    analytics.log("definitely_not_an_event");

    // @ts-expect-error - "project_name" is not a declared parameter.
    analytics.log("app_opened", { project_name: "Midnight Drive" });

    // A `@ts-expect-error` is attributed to the line the error is *reported*
    // on, which for a multi-line object literal is the offending property
    // rather than the call. Binding each payload first keeps the reported
    // error on the line directly after its directive, whatever the formatter
    // does to line lengths.
    const typo = { editor: "steps", event_count_bucket: "1_4" } as const;
    // @ts-expect-error - "steps" is not a declared value of `editor`.
    analytics.log("clip_edited", typo);

    const freeText = {
      editor: "user typed this" as string,
      event_count_bucket: "1_4",
    } as const;
    // @ts-expect-error - free text can never satisfy an enum parameter.
    analytics.log("clip_edited", freeText);

    // @ts-expect-error - `event_count_bucket` is required.
    analytics.log("clip_edited", { editor: "step" });

    // A correct call still compiles.
    analytics.log("clip_edited", { editor: "step", event_count_bucket: "1_4" });
  });

  it("cannot log an event whose keys a later task still owns", () => {
    const { analytics } = setup();
    // `arrangement_outline_created`'s `template_id` keys are authored by
    // ARR-003. Until then the enum is empty, so the event is declared but
    // un-loggable — no call site can ship ahead of its keys. (`device_added`
    // was the example here until LOOP-008 claimed its `device_type` keys, and
    // `shortcut_used` before that until LOOP-014.)
    const emptyEnum = {
      template_id: "verse_chorus",
      section_count: 4,
    } as const;
    // @ts-expect-error - no value satisfies an empty enum.
    analytics.log("arrangement_outline_created", emptyEnum);
  });

  it("logs device_added now that LOOP-008 has claimed its device_type keys", () => {
    const { analytics } = setup();
    // A correct call compiles...
    analytics.log("device_added", { device_type: "reverb", chain: "insert" });
    // ...but an unregistered device type does not.
    const unknownType = { device_type: "bitcrusher", chain: "insert" } as const;
    // @ts-expect-error - "bitcrusher" is not one of the authored device types.
    analytics.log("device_added", unknownType);
  });
});

describe("transports", () => {
  it("records nothing through the no-op default", () => {
    const analytics = new Analytics({
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    expect(() => analytics.log("app_opened")).not.toThrow();
  });

  it("reports whether a once-only key has already fired", () => {
    const { analytics } = setup();
    expect(analytics.hasFired("feature:synth")).toBe(false);
    analytics.logFeatureFirstUse("synth");
    expect(analytics.hasFired("feature:synth")).toBe(true);
  });

  it("keeps a failing transport from stopping a later working one", () => {
    const failing: AnalyticsTransport = createFailingTransport();
    const analytics = new Analytics({
      transport: failing,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    analytics.log("app_opened");
    const working = createRecordingTransport();
    analytics.setTransport(working);
    analytics.log("app_opened");
    expect(working.events).toHaveLength(1);
  });
});
