// Payload scrubbing for the error-monitoring transport (PRD `OPS-03`,
// ADR 0001 "What this costs").
//
// Groove's value to a user is their private music. A third-party error
// SDK collects more by default than a hand-built reporter would — console
// arguments, request URLs, DOM text — so this file exists to remove it
// *before* transmission rather than to trust configuration alone.
//
// These functions are deliberately free of any Sentry import. They operate on
// minimal structural types, which means `scrub.test.ts` can exercise them
// directly on hostile input — which is what the PRD `OPS-02` / `OPS-03`
// "no project content" acceptance criterion requires, and it is why the test
// keeps working for events and breadcrumbs added by later tasks.
//
// ## The one thing deliberately NOT removed
//
// Stack frame `filename`/`abs_path` values are our own bundle URLs
// (`https://<host>/_build/assets/editor-abc123.js`). They are kept, minus any
// query string or fragment, because `OPS-03` requires symbolicated production
// stack traces and Sentry matches source maps against exactly these paths.
// They are our code's location, not the user's content: not an asset URL, not
// a user-entered string, not a token. Everything else URL-shaped is removed.

/** Longest message we transmit. Anything beyond is truncated, not sent. */
export const MAX_MESSAGE_LENGTH = 300;

export const REDACTED = "[redacted]";

/**
 * Ordered redaction rules. Applied in sequence, so more specific shapes
 * (tokens, emails) are matched before broader ones (quoted text, digits).
 */
const REDACTIONS: readonly { pattern: RegExp; replacement: string }[] = [
  // Any URL-ish scheme, including the ones an audio app produces for user
  // assets (`blob:`, `data:`, `filesystem:`).
  {
    pattern: /\b(?:https?|ftp|ws|wss|blob|data|file|filesystem):[^\s"'`)<>\]]+/gi,
    replacement: "[url]",
  },
  // Protocol-relative and bare host/path references.
  {
    pattern: /\/\/[\w.-]+\.[a-z]{2,}(?:\/[^\s"'`)<>\]]*)?/gi,
    replacement: "[url]",
  },
  { pattern: /\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/gi, replacement: "[email]" },
  // JWTs.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: "[token]",
  },
  // Long opaque secrets: API keys, bearer tokens, session identifiers.
  { pattern: /\b[A-Za-z0-9_-]{32,}\b/g, replacement: "[token]" },
  // Absolute filesystem paths (a dropped file's name lives here).
  {
    pattern: /(?:[A-Za-z]:)?[\\/](?:[\w .-]+[\\/]){2,}[\w .-]+/g,
    replacement: "[path]",
  },
  // Quoted text. Error messages embed user-supplied values in quotes far more
  // often than not, and nothing can distinguish `"My Demo Track"` from
  // `"tracks"` at this layer, so quoted content always goes. This costs some
  // diagnostic detail in exchange for a guarantee; the symbolicated stack
  // trace is where the real diagnosis happens.
  { pattern: /"[^"]*"/g, replacement: `"${REDACTED}"` },
  { pattern: /'[^']*'/g, replacement: `'${REDACTED}'` },
  { pattern: /`[^`]*`/g, replacement: `\`${REDACTED}\`` },
  // Long digit runs: phone numbers, account identifiers, precise timestamps.
  { pattern: /\b\d{7,}\b/g, replacement: "[n]" },
];

/**
 * Redacts a free-text string down to something safe to transmit.
 *
 * Total and non-throwing: called from the reporting path, which must never
 * fail in a way that costs the user their unsaved work.
 */
export function redactText(value: unknown): string {
  if (typeof value !== "string") {
    // Never stringify an arbitrary object — its fields are exactly the
    // project state this function exists to keep out of the payload.
    return value === undefined || value === null ? "" : `[${typeof value}]`;
  }
  let result = value;
  for (const { pattern, replacement } of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  result = result.trim();
  return result.length > MAX_MESSAGE_LENGTH
    ? `${result.slice(0, MAX_MESSAGE_LENGTH)}…`
    : result;
}

/**
 * Reduces a URL to its path, dropping origin, query, and fragment.
 *
 * **Not safe to transmit on its own.** The pathname it returns is whatever the
 * URL contained, so a user-named asset or project survives it intact, and a
 * non-`http` scheme puts its whole payload in the pathname
 * (`data:audio/wav;base64,…` → `audio/wav;base64,…`). It exists as the input
 * step of `scrubRoute`, which is what rebuilds the path into a safe shape.
 * Anything leaving this module URL-shaped goes through `scrubRoute`.
 */
export function pathOnly(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  try {
    return new URL(value, "https://placeholder.invalid").pathname;
  } catch {
    return "";
  }
}

/**
 * Strips query and fragment from a stack-frame path, keeping the part Sentry
 * matches source maps against. See the file banner for why this is kept.
 */
export function scrubFramePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * Hosts whose request paths name stored documents and objects: Firestore and
 * the two Cloud Storage endpoints. Their paths are reduced to IDs.
 */
const DATA_API_HOSTS = [
  "firestore.googleapis.com",
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
];

/** The structural words of the Firestore and Storage REST and channel paths. */
const DATA_API_SEGMENT =
  /^(?:v\d+(?:beta\d+)?|b|o|projects|databases|documents|\(default\)|google\.firestore\.v1\.Firestore|Listen|Write|channel)$/;

/** A Firebase UID or a Firestore auto-ID: opaque by construction. */
const FIREBASE_ID = /^[A-Za-z0-9]{20,28}$/;

/**
 * Reduces a request URL to what a session replay's network timing may carry
 * (GRV-120): origin and path, never a query string or fragment, which is where
 * Firebase Storage download tokens, auth API keys and session identifiers
 * ride.
 *
 * A Firestore or Storage path names documents and objects, so it keeps its
 * IDs only: each segment (an encoded Storage object path is split too) is kept
 * if it is one of the APIs' own words or a prefixed or Firebase ID, and
 * becomes `:param` otherwise. A `data:` or `blob:` URL keeps only its scheme,
 * since its payload is the rest of it. `undefined` for anything unreadable,
 * which drops the request.
 */
export function scrubNetworkUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!/^(?:https?|wss?):$/.test(url.protocol)) return url.protocol;
  if (!DATA_API_HOSTS.includes(url.hostname)) return `${url.origin}${url.pathname}`;
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .flatMap((segment) => {
      try {
        return decodeURIComponent(segment).split("/");
      } catch {
        return [segment];
      }
    })
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      DATA_API_SEGMENT.test(segment) ||
      PREFIXED_ID.test(segment) ||
      FIREBASE_ID.test(segment)
        ? segment
        : ":param",
    );
  return `${url.origin}/${segments.join("/")}`;
}

/**
 * Static path segments that appear in Groove's own routes.
 *
 * Kept in step with `src/routes`. A segment missing from here is not a leak,
 * only a less specific transaction name, which is the correct direction to
 * fail in.
 */
export const ALLOWED_ROUTE_SEGMENTS = [
  "dashboard",
  "projects",
  "spike",
  "arrangement",
] as const;

/** A PRD section 9.4 prefixed ID (`prj_…`, `trk_…`), which carries no content. */
const PREFIXED_ID = /^[a-z]{2,5}_[A-Za-z0-9_-]{4,}$/;

/**
 * Reduces a URL or transaction name to its route *shape*.
 *
 * Applies to every URL-derived value we transmit: `event.transaction`, the
 * network breadcrumb's request URL, and the navigation breadcrumb's `from`/
 * `to`. All of them are route identifiers rather than free text, and
 * `redactText` is the wrong tool for them: a bare path segment like
 * `/projects/Midnight Drive Demo` contains no quotes, scheme, or separator for
 * a text rule to key on, so it would travel intact.
 *
 * Treated structurally instead, matching this file's allowlist stance: a
 * segment is kept only if it is a route word we ship or a prefixed domain ID.
 * Anything else — which is to say anything a user could have named, including
 * an asset filename inside a storage URL — becomes `:param`. That also makes
 * this total for the schemes an audio app produces: `data:` and `blob:` put
 * their payload in the pathname, and every segment of it is `:param`.
 */
export function scrubRoute(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const path = pathOnly(value);
  if (path === "") return undefined;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "/" : `/${segments.map(routeSegment).join("/")}`;
}

function routeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape sequence stays as-is; it matches neither branch below
    // and therefore becomes `:param`, which is the safe outcome anyway.
  }
  if ((ALLOWED_ROUTE_SEGMENTS as readonly string[]).includes(decoded)) {
    return decoded;
  }
  return PREFIXED_ID.test(decoded) ? ":id" : ":param";
}

/**
 * Reduces a DOM selector to tag names only.
 *
 * `button.primary[aria-label="Delete My Demo Track"]` becomes `button`. An
 * accessible name is user content in this product — it is frequently a clip,
 * track, or project name — so nothing but the element type survives.
 */
export function scrubSelector(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tags = value
    .split(/\s*>\s*|\s+/)
    .map((segment) => /^[a-z][a-z0-9-]*/.exec(segment)?.[0])
    .filter((tag): tag is string => Boolean(tag));
  return tags.length > 0 ? tags.join(" > ") : undefined;
}

// ---------------------------------------------------------------------------
// Structural types
// ---------------------------------------------------------------------------
//
// Intentionally minimal and local rather than imported from `@sentry/core`:
// this module stays SDK-free so the scrubbing contract is testable on its own
// and survives an SDK swap (ADR 0001, "Exit cost is bounded").

export interface ScrubbableBreadcrumb {
  category?: string;
  type?: string;
  level?: string;
  message?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

export interface ScrubbableFrame {
  filename?: string;
  abs_path?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  // Source context lines are the *contents* of our bundle, not user data, but
  // they are dropped anyway: Sentry re-derives them from the uploaded source
  // map, so transmitting them adds payload for nothing.
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
  vars?: Record<string, unknown>;
}

export interface ScrubbableException {
  type?: string;
  value?: string;
  mechanism?: Record<string, unknown>;
  stacktrace?: { frames?: ScrubbableFrame[] };
}

export interface ScrubbableEvent {
  message?: string;
  transaction?: string;
  exception?: { values?: ScrubbableException[] };
  breadcrumbs?: ScrubbableBreadcrumb[];
  request?: unknown;
  user?: unknown;
  server_name?: string;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Contexts that may be transmitted. Everything else is dropped, because
 * framework integrations attach application state under keys we do not
 * control and cannot audit ahead of time.
 */
export const ALLOWED_CONTEXTS = ["browser", "os", "device", "trace"] as const;

/**
 * Tags our own reporting boundary sets (see `errorReporting.ts`). An
 * unrecognized tag is dropped rather than trusted.
 */
export const ALLOWED_TAGS = [
  "area",
  "error_code",
  "fatal",
  "surface",
  "account_type",
  "internal",
  "browser_name",
  "browser_version",
  "engine_name",
  "engine_version",
  // The triage context (GRV-55); `errorContext.test.ts` pins these to
  // `ERROR_CONTEXT_KEYS`.
  "online",
  "retry_count",
  "audio_context_state",
  "export_type",
  "file_size_bucket",
  "duration_bucket",
  "track_count_bucket",
  "zip_count",
  "leaked_node_bucket",
  "leaked_subscription_bucket",
  "leaked_other_bucket",
] as const;

function allowlist(
  source: Record<string, unknown> | undefined,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * `beforeBreadcrumb`: scrubs one breadcrumb, or drops it by returning `null`.
 */
export function scrubBreadcrumb(
  breadcrumb: ScrubbableBreadcrumb,
): ScrubbableBreadcrumb | null {
  const category = breadcrumb.category ?? "";

  // Console breadcrumbs are disabled at the integration level (ADR 0001:
  // "console breadcrumbs are disabled rather than filtered"). Dropping them
  // here too means a future integration change cannot quietly turn them on.
  if (category === "console") return null;

  const base: ScrubbableBreadcrumb = {
    category: breadcrumb.category,
    type: breadcrumb.type,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
  };

  if (category === "fetch" || category === "xhr") {
    const data = breadcrumb.data ?? {};
    return {
      ...base,
      // The message is the request URL and is dropped outright. The request
      // path survives only as a route *shape*: a request to our own asset
      // endpoint carries a user-named file
      // (`/o/users%2Fu1%2FMy Secret Sample.wav`), which `scrubRoute` reduces
      // to `:param` while keeping the endpoint recognizable.
      data: {
        method: typeof data.method === "string" ? data.method : undefined,
        status_code: typeof data.status_code === "number" ? data.status_code : undefined,
        url_path: scrubRoute(data.url),
      },
    };
  }

  if (category.startsWith("ui.")) {
    const selector = scrubSelector(breadcrumb.message);
    return selector ? { ...base, message: selector } : base;
  }

  if (category === "navigation") {
    const data = breadcrumb.data ?? {};
    return {
      ...base,
      // A route can contain a name the user chose (`/projects/My Demo`), so
      // both endpoints are reduced to a route shape rather than a raw path.
      data: { from: scrubRoute(data.from), to: scrubRoute(data.to) },
    };
  }

  // Anything else — including breadcrumb categories a later task adds — gets
  // its message redacted and its arbitrary data dropped.
  const message = redactText(breadcrumb.message);
  return message ? { ...base, message } : base;
}

/**
 * `beforeSend`: scrubs a whole event, or drops it by returning `null`.
 *
 * Structured as an allowlist over the fields we understand plus redaction of
 * the free-text ones, so a field a future SDK version starts populating is
 * dropped by default rather than transmitted by default.
 */
export function scrubSentryEvent(event: ScrubbableEvent): ScrubbableEvent {
  const scrubbed: ScrubbableEvent = { ...event };

  // Whole-field removals. `request` carries the page URL, headers, and
  // cookies; `user` carries whatever identity the SDK inferred; `extra` is an
  // arbitrary bag any integration can write to.
  scrubbed.request = undefined;
  scrubbed.user = undefined;
  scrubbed.server_name = undefined;
  scrubbed.extra = undefined;

  if (event.message !== undefined) {
    scrubbed.message = redactText(event.message);
  }
  if (event.transaction !== undefined) {
    scrubbed.transaction = scrubRoute(event.transaction);
  }

  scrubbed.contexts = allowlist(event.contexts, ALLOWED_CONTEXTS);
  scrubbed.tags = allowlist(event.tags, ALLOWED_TAGS);

  if (event.exception?.values) {
    scrubbed.exception = {
      values: event.exception.values.map(scrubException),
    };
  }

  if (event.breadcrumbs) {
    scrubbed.breadcrumbs = event.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((crumb): crumb is ScrubbableBreadcrumb => crumb !== null);
  }

  return scrubbed;
}

function scrubException(exception: ScrubbableException): ScrubbableException {
  return {
    // The error class name (`TypeError`, `RevisionConflictError`) is a code
    // identifier, and it is what Sentry groups on.
    type: exception.type,
    value: redactText(exception.value),
    mechanism: exception.mechanism,
    stacktrace: exception.stacktrace
      ? { frames: (exception.stacktrace.frames ?? []).map(scrubFrame) }
      : undefined,
  };
}

function scrubFrame(frame: ScrubbableFrame): ScrubbableFrame {
  return {
    filename: scrubFramePath(frame.filename),
    abs_path: scrubFramePath(frame.abs_path),
    function: frame.function,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
    // `vars` and the context lines are dropped: local variables at the throw
    // site are the single most likely place for a clip name or a note array
    // to appear in a payload.
  };
}

// ---------------------------------------------------------------------------
// PostHog exception events (ADR 0011 decision 3, GRV-120)
// ---------------------------------------------------------------------------
//
// PostHog builds its `$exception` event from the error object the PostHog
// sink hands it, exactly as Sentry does, so the raw message and the raw stack
// are in it. The PostHog transport runs every outgoing event through
// `scrubPostHogEvent` (its `before_send`), which gives the exception the same
// treatment `scrubSentryEvent` gives Sentry's: the message redacted, frames
// reduced to our code's location, and nothing else kept.

export interface ScrubbablePostHogFrame {
  platform?: string;
  filename?: string;
  abs_path?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  /** What PostHog matches an uploaded source map by. */
  chunk_id?: string;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
  vars?: Record<string, unknown>;
}

export interface ScrubbablePostHogException {
  type?: string;
  value?: string;
  mechanism?: Record<string, unknown>;
  module?: string;
  stacktrace?: { type?: string; frames?: ScrubbablePostHogFrame[] };
}

export interface ScrubbablePostHogEvent {
  event?: string;
  properties?: Record<string, unknown>;
}

/** The mechanism fields PostHog groups and links causes by. */
const POSTHOG_MECHANISM_FIELDS = [
  "type",
  "handled",
  "synthetic",
  "exception_id",
  "parent_id",
  "source",
] as const;

/**
 * Exception properties PostHog may attach beyond the list itself. Steps are a
 * breadcrumb trail any code can write a message into; the legacy message and
 * the source context are free text.
 */
const POSTHOG_DROPPED_EXCEPTION_PROPERTIES = [
  "$exception_steps",
  "$exception_message",
  "$exception_source",
  "$exception_personURL",
] as const;

/**
 * `before_send` for the PostHog client: scrubs a `$exception` event and passes
 * every other event through untouched. Never throws; an exception event it
 * cannot read is dropped (`null`) rather than sent unscrubbed.
 */
export function scrubPostHogEvent<T extends ScrubbablePostHogEvent>(
  event: T | null,
): T | null {
  if (!event || event.event !== "$exception") return event;
  try {
    const properties: Record<string, unknown> = { ...event.properties };
    const list = properties.$exception_list;
    properties.$exception_list = Array.isArray(list)
      ? list.map((exception) =>
          scrubPostHogException(exception as ScrubbablePostHogException),
        )
      : [];
    for (const key of POSTHOG_DROPPED_EXCEPTION_PROPERTIES) delete properties[key];
    if (typeof properties.$exception_type === "string") {
      properties.$exception_type = redactText(properties.$exception_type);
    }
    return { ...event, properties };
  } catch {
    return null;
  }
}

function scrubPostHogException(
  exception: ScrubbablePostHogException,
): ScrubbablePostHogException {
  const mechanism = exception.mechanism
    ? (allowlist(exception.mechanism, POSTHOG_MECHANISM_FIELDS) ?? {})
    : undefined;
  return {
    type: exception.type,
    value: redactText(exception.value),
    mechanism,
    stacktrace: exception.stacktrace
      ? {
          type: exception.stacktrace.type ?? "raw",
          frames: (exception.stacktrace.frames ?? []).map(scrubPostHogFrame),
        }
      : undefined,
  };
}

function scrubPostHogFrame(frame: ScrubbablePostHogFrame): ScrubbablePostHogFrame {
  return {
    platform: frame.platform,
    filename: scrubFramePath(frame.filename),
    abs_path: scrubFramePath(frame.abs_path),
    function: frame.function,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
    chunk_id: frame.chunk_id,
    // `module`, `vars` and the context lines are dropped, as for Sentry.
  };
}
