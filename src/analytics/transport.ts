// The analytics transport seam (PRD `OPS-02`, ADR 0001 decision 1).
//
// The logging boundary in `analytics.ts` validates, enriches, and hands a
// finished event to a transport. Which vendor actually receives it is behind
// this interface, so swapping PostHog — or running with no vendor at all, which is what every test and every opted-out session does — changes one
// wiring line rather than every call site.
//
// A transport MUST NOT throw. Analytics fails open (PRD `OPS-02`: "A blocked,
// failed, or unavailable analytics endpoint ... never breaks playback,
// editing, saving, or export"). The boundary guards against a throwing
// transport anyway, but a transport that swallows its own failures keeps that
// guard a backstop rather than the primary mechanism.

import type { AnalyticsParamValue } from "./catalog";

export interface AnalyticsTransport {
  logEvent(name: string, params: Readonly<Record<string, AnalyticsParamValue>>): void;
  /** Person properties: account type and the internal-traffic flag. */
  setUserProperties(properties: Readonly<Record<string, string>>): void;
  /** Attributes what follows to a signed-in account, by Firebase UID alone. */
  identify(userId: string): void;
  /** Forgets the signed-in account, on sign-out. */
  resetIdentity(): void;
  /** One page view, sent by the router on navigation. */
  pageview(): void;
}

/** Discards everything. The default until a real transport is wired in. */
export const noopTransport: AnalyticsTransport = {
  logEvent() {},
  setUserProperties() {},
  identify() {},
  resetIdentity() {},
  pageview() {},
};

export interface RecordedEvent {
  readonly name: string;
  readonly params: Record<string, AnalyticsParamValue>;
}

export interface RecordingTransport extends AnalyticsTransport {
  readonly events: readonly RecordedEvent[];
  readonly userProperties: Readonly<Record<string, string>>;
  /** The UID the transport was last identified as, or `null`. */
  readonly userId: string | null;
  /** How many times the identity was reset (signed out). */
  readonly identityResets: number;
  /** How many page views were sent. */
  readonly pageviews: number;
  /** Events recorded for one name, in order. */
  named(name: string): readonly RecordedEvent[];
  reset(): void;
}

/** An in-memory transport for tests and for the local debug surface. */
export function createRecordingTransport(): RecordingTransport {
  const events: RecordedEvent[] = [];
  let userProperties: Record<string, string> = {};
  let userId: string | null = null;
  let identityResets = 0;
  let pageviews = 0;

  return {
    get events() {
      return events;
    },
    get userProperties() {
      return userProperties;
    },
    get userId() {
      return userId;
    },
    get identityResets() {
      return identityResets;
    },
    get pageviews() {
      return pageviews;
    },
    named(name) {
      return events.filter((event) => event.name === name);
    },
    logEvent(name, params) {
      events.push({ name, params: { ...params } });
    },
    setUserProperties(properties) {
      userProperties = { ...userProperties, ...properties };
    },
    identify(id) {
      userId = id;
    },
    resetIdentity() {
      userId = null;
      identityResets += 1;
    },
    pageview() {
      pageviews += 1;
    },
    reset() {
      events.length = 0;
      userProperties = {};
      userId = null;
      identityResets = 0;
      pageviews = 0;
    },
  };
}

/**
 * A transport that always throws, for the PRD `OPS-02` acceptance test that
 * "disabling or blocking analytics leaves every product behavior unchanged".
 */
export function createFailingTransport(
  message = "analytics blocked",
): AnalyticsTransport {
  const fail = () => {
    throw new Error(message);
  };
  return {
    logEvent: fail,
    setUserProperties: fail,
    identify: fail,
    resetIdentity: fail,
    pageview: fail,
  };
}
