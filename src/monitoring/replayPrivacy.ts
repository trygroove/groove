// Session Replay's privacy position (ADR 0002 decision 2, ADR 0003, and ADR
// 0011 decision 2, which moved replay to PostHog under the same conditions).
//
// Everything here is vendor-free: plain strings and pure functions, so the
// rules can be tested directly and so `src/analytics/posthogTransport.ts`, the
// one module that imports `posthog-js`, only has to hand them to the SDK.
//
// ## Masked by default
//
// The recorder masks every text node (`maskTextSelector: "*"`), every input
// value, and the attributes in `MASK_ATTRIBUTES`, at capture in the browser,
// so a masked string is never serialized and never transmitted. That default
// is the primary safeguard. The only way back from it is a selector named in
// `REPLAY_UNMASK_SELECTORS` below, and there are none.
//
// Components also mark themselves (`MASK_CONTENT`), which is the second
// safeguard and is deliberately narrow: the few elements *known* to render a
// name the user typed, so the marking survives the day someone names an
// unmask selector to make a replay readable.
//
// ## Narrow on purpose
//
// The temptation is to mark every container that could conceivably hold
// something private — the mixer, the arrangement, a project card. Resist it.
// Replay exists to show where people get stuck (ADR 0002 decision 1), and a
// replay in which the editor is a field of grey blocks answers no question at
// all. So the bar is specific: **this element renders a string a user typed.**
// In schema v1 that is three things — a project name, a track name, a clip
// name, the only `name` fields a command can write — plus the contents of a
// text input, notably the search boxes PRD OPS-03 names directly.
//
// What is deliberately *not* marked:
//
//   - **Asset, pad, and pack names**: library facts we ship, identical for
//     every user. Masking them hides which sound someone reached for.
//   - **Note and clip geometry** (piano-roll notes, the arrangement canvas):
//     no text to mask. Masking replaces characters, not shapes. Canvas capture
//     is on (ADR 0003 decision 1) and masking does not reach inside a canvas,
//     which the disclosure says plainly.
//   - **Structural containers** (a mixer strip, a project card, a panel): the
//     name inside is marked instead, so the controls around it stay legible.
//
// ## Attributes are a separate lever
//
// A class marks text nodes and input values. It does not touch attributes, and
// in this codebase the attributes are where the names actually leak: accessible
// names are built by interpolation — `aria-label={`Mute ${track.name}`}` on a
// mixer button, `Piano roll: ${clip.name}` on the roll — so a track or clip
// name reaches the recording through an element whose *text* holds nothing
// private at all. `maskReplayAttribute` masks those by attribute name, on
// every element, and strips the query string and fragment from every URL
// attribute, where a token would ride.
//
// `replayPrivacy.test.ts` pins the surfaces that carry a marking and the ones
// that must stay without one; `replayPayload.test.ts` runs PostHog's own
// recorder over a hostile page and asserts against what it emits.

import { scrubNetworkUrl } from "./scrub";

/**
 * PostHog's mask class (its recorder's `maskTextClass` default): this
 * element's text is masked at capture.
 */
export const MASK_CONTENT = "ph-mask";

/**
 * The named exceptions to "all text is masked" (ADR 0002 decision 2).
 *
 * Unmasking is permitted only for stable, non-user-authored chrome, and only
 * by an explicit selector written here — never by a component deciding for
 * itself that its own content is safe. There are none: until a specific
 * surface proves unreadable in a replay, there is nothing to name.
 */
export const REPLAY_UNMASK_SELECTORS: readonly string[] = [];

/** Every text node is masked; `maskReplayText` lets the named unmasks through. */
export const MASK_ALL_TEXT_SELECTOR = "*";

/**
 * Attribute names whose values are masked at capture, on every element.
 *
 * `aria-label` is here because it is where a track, clip, or project name
 * reaches the DOM in this codebase (`replayPrivacy.test.ts` scans for that and
 * fails on a name interpolated into any attribute this list does not cover).
 * `title` and `placeholder` are here because they carry the same kind of
 * string.
 */
export const MASK_ATTRIBUTES: readonly string[] = ["title", "placeholder", "aria-label"];

/**
 * Attributes that carry a URL. The recorder keeps their path, so a replay can
 * still show where a link went, but never their query string or fragment.
 */
export const URL_ATTRIBUTES: readonly string[] = [
  "href",
  "src",
  "srcset",
  "poster",
  "action",
  "data",
  "xlink:href",
];

/**
 * Elements recorded as an empty box: no children, no attributes. The
 * successor of Sentry's `blockAllMedia`: images, video and audio are media,
 * not interface, and an asset URL rides on them.
 */
export const BLOCK_MEDIA_SELECTOR =
  "img, image, svg, video, object, picture, embed, map, audio";

/**
 * ADR 0002 decision 6: "set low (start at 0.1 and adjust against the free-tier
 * quota)". Replay is a sampled qualitative instrument, not a measure any
 * release gate depends on, so an undercount costs nothing structural.
 */
export const REPLAY_SESSION_SAMPLE_RATE = 0.1;

/** What masked text becomes: each visible character replaced, spacing kept. */
export function maskCharacters(value: string): string {
  return value.replace(/\S/g, "*");
}

/**
 * The recorder's text mask. Called for every text node, since every node
 * matches `MASK_ALL_TEXT_SELECTOR`; it returns the text unmasked only inside
 * an element a named unmask selector matches.
 */
export function maskReplayText(text: string, element?: Element | null): string {
  if (element && REPLAY_UNMASK_SELECTORS.length > 0) {
    try {
      if (element.closest(REPLAY_UNMASK_SELECTORS.join(", "))) return text;
    } catch {
      // An invalid selector unmasks nothing, which is the safe direction.
    }
  }
  return maskCharacters(text);
}

/** The recorder's attribute mask: names masked, URLs stripped of their query. */
export function maskReplayAttribute(name: string, value: string): string {
  const attribute = name.toLowerCase();
  if (MASK_ATTRIBUTES.includes(attribute)) return maskCharacters(value);
  if (attribute === "srcset") {
    return value
      .split(",")
      .map((candidate) => {
        const [url = "", ...descriptor] = candidate.trim().split(/\s+/);
        return [stripQuery(url), ...descriptor].join(" ");
      })
      .join(", ");
  }
  if (URL_ATTRIBUTES.includes(attribute)) return stripQuery(value);
  return value;
}

function stripQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * One network request as the recorder reports it: the shape PostHog calls
 * `CapturedNetworkRequest`, reduced to what this module reads and writes.
 */
export interface ReplayNetworkRequest {
  name?: string;
  requestHeaders?: unknown;
  requestBody?: unknown;
  responseHeaders?: unknown;
  responseBody?: unknown;
  [key: string]: unknown;
}

/**
 * What a replay may record of a request: its method, status and timing.
 *
 * The URL keeps its origin and path but never its query string or fragment,
 * which is where Firebase Storage download tokens, auth keys and session
 * identifiers ride; a Firestore or Storage path keeps its IDs and loses every
 * other segment (`scrubNetworkUrl`). Headers and bodies are dropped here as
 * well as switched off in the recorder's options, so a project setting that
 * turned them on would still record none. A URL that cannot be read drops the
 * request.
 *
 * PostHog also passes the page's own URL through this, as `{ name }`, before
 * a recording's metadata carries it.
 */
export function maskReplayNetworkRequest<T extends ReplayNetworkRequest>(
  request: T,
): T | undefined {
  const name = scrubNetworkUrl(request.name);
  if (!name) return undefined;
  const masked: T = { ...request, name };
  delete masked.requestHeaders;
  delete masked.requestBody;
  delete masked.responseHeaders;
  delete masked.responseBody;
  return masked;
}

/**
 * Whether a session is in the replay sample, the same decision PostHog's
 * recorder makes for `session_recording.sampleRate` (`sampleOnProperty`: a
 * 31-multiplier string hash of the session ID, modulo 100). Made here first so
 * the recorder is only loaded for a session it will record;
 * `replayPayload.test.ts` checks it agrees with the SDK's.
 */
export function isSessionSampled(sessionId: string, rate: number): boolean {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash << 5) - hash + sessionId.charCodeAt(i);
    hash |= 0;
  }
  const percent = Math.min(Math.max(rate * 100, 0), 100);
  return Math.abs(hash) % 100 < percent;
}
