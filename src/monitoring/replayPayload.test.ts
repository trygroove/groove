// ADR 0002 decision 3: "The `OPS-03` content rule extends to the replay
// payload. 'No project content, assistant text, user-entered strings, asset
// URLs, or tokens' already governs events and breadcrumbs. It now governs
// replays, and is enforced the same way — positively, by test, against the
// serialized payload rather than by inspection of the configuration."
//
// Rebuilt for PostHog's recorder (ADR 0011 decision 2, GRV-120). The earlier
// version modelled Sentry's masking, because Sentry's recorder could not run
// here; PostHog's can. So this file runs the real thing: the real `posthog-js`
// client, initialized with the transport's own `postHogInitOptions`, records
// a hostile page with the bundled recorder, and every assertion is about what
// that recorder emitted. Nothing here restates the configuration, and nothing
// can certify a payload shape the recorder would not actually clean.
//
// What it cannot see:
//
// - **Canvas pixels.** ADR 0003 turns canvas capture on, and no masking rule
//   reaches inside a canvas: what the arrangement renderer draws is recorded
//   as drawn. That is the decision, disclosed to the user, not a leak.
// - **What PostHog does after the recorder emits**, which only removes
//   things: compression, and passing the page URL through
//   `maskCapturedNetworkRequestFn`. The network test below runs PostHog's own
//   request-options builder for that half.
//
// And two real gaps it says so about rather than hiding: a `data-*` attribute
// and a URL's *path* are recorded as written. The source guards at the end
// keep anything user-authored out of both.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildNetworkRequestOptions } from "posthog-js/lib/src/extensions/replay/external/config";
import { sampleOnProperty } from "posthog-js/lib/src/extensions/sampling";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  POSTHOG_DEFAULT_HOST,
  POSTHOG_SESSION_RECORDING,
  postHogInitOptions,
} from "../analytics/posthogTransport";
import {
  isSessionSampled,
  MASK_CONTENT,
  REPLAY_SESSION_SAMPLE_RATE,
} from "./replayPrivacy";

const sourceRoot = join(process.cwd(), "src");

/** Every component source in `src/`, which is where a `data-*` can be bound. */
function sourceFiles(dir = sourceRoot): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * The forbidden content, from PRD `OPS-02` / `OPS-03` / section 10, matching
 * `scrub.test.ts`'s list: "no project content, assistant text, user-entered
 * strings, asset URLs, or tokens".
 */
const FORBIDDEN = {
  projectName: "Midnight Drive Demo",
  trackName: "Lead Vocal Take 3",
  clipName: "Chorus Riff",
  assetName: "my-secret-sample.wav",
  assetUrl: "https://storage.googleapis.com/solid-groove/users/u1/kick.wav",
  assistantText: "Make the chorus feel more euphoric with a wide pad",
  searchTerm: "dusty vinyl piano",
  token:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
} as const;

function expectNoForbiddenContent(payload: string): void {
  for (const [label, value] of Object.entries(FORBIDDEN)) {
    expect(payload.includes(value), `${label} reached the replay payload: ${value}`).toBe(
      false,
    );
  }
}

/**
 * The expressions a bound attribute value actually interpolates.
 *
 * A template literal is reduced to its `${…}` holes, because its static parts
 * are our own source text and only the holes can carry user content. Anything
 * else is returned whole. Keeps the allowlist a list of *expressions* rather
 * than of literal spellings, so reformatting a route does not require editing it.
 */
function boundExpressions(bound: string): string[] {
  if (!bound.startsWith("`") || !bound.endsWith("`")) return [bound];
  return [...bound.matchAll(/\$\{([^{}]*)\}/g)].map((hole) => hole[1].trim());
}

// ---------------------------------------------------------------------------
// The recorder harness
// ---------------------------------------------------------------------------

const KEY = "phc_replay_payload_test";

/** The page on screen when recording starts: its FullSnapshot is checked. */
const INITIAL_PAGE = `
	<main>
		<section class="${MASK_CONTENT}">
			<h1>${FORBIDDEN.projectName}</h1>
			<button aria-label="Rename ${FORBIDDEN.trackName}">Rename</button>
			<input value="${FORBIDDEN.clipName}" placeholder="${FORBIDDEN.searchTerm}" />
			<span title="${FORBIDDEN.assetName}">Sample</span>
			<img alt="${FORBIDDEN.trackName}" src="${FORBIDDEN.assetUrl}" />
			<p>${FORBIDDEN.assistantText}</p>
		</section>
	</main>
`;

interface RecorderEvent {
  type: number;
  data?: unknown;
}

type ExtensionWindow = Window & {
  __PosthogExtensions__?: {
    rrweb?: { record?: (options: Record<string, unknown>) => unknown };
  };
  _POSTHOG_REMOTE_CONFIG?: Record<string, { config: Record<string, unknown> }>;
};

const emitted: RecorderEvent[] = [];
const realFetch = globalThis.fetch;

/**
 * Starts the real client recording, with every event the recorder emits
 * copied into `emitted`. The project's remote config is supplied up front, as
 * PostHog's own snippet can, so no request leaves the test.
 */
async function startRecording(): Promise<void> {
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200 })) as unknown as typeof fetch;
  // jsdom has no canvas backend; the recorder's canvas capture asks for
  // pixels it cannot have, which is noise rather than anything under test.
  HTMLCanvasElement.prototype.toDataURL = () => "data:,";
  const win = window as ExtensionWindow;
  win._POSTHOG_REMOTE_CONFIG = {
    [KEY]: { config: { sessionRecording: { endpoint: "/s/" }, hasFeatureFlags: false } },
  };
  await import("posthog-js/dist/posthog-recorder");
  const rrweb = win.__PosthogExtensions__?.rrweb;
  const record = rrweb?.record;
  if (!rrweb || !record) throw new Error("the bundled recorder did not install itself");
  const tapped = (options: Record<string, unknown>) => {
    const emit = options.emit as (event: RecorderEvent, checkout?: boolean) => void;
    return record({
      ...options,
      emit: (event: RecorderEvent, checkout?: boolean) => {
        emitted.push(JSON.parse(JSON.stringify(event)));
        emit(event, checkout);
      },
    });
  };
  rrweb.record = Object.assign(tapped, record);

  document.body.innerHTML = INITIAL_PAGE;
  const { default: posthog } = await import("posthog-js");
  const client = posthog.init(KEY, postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory"));
  if (!client) throw new Error("posthog-js did not initialize");
  // The loader starts recording only for a sampled session; this one is put
  // in the sample so the recorder runs.
  client.startSessionRecording({ sampling: true });
  for (
    let i = 0;
    i < 100 && !emitted.some((event) => event.type === FULL_SNAPSHOT);
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!emitted.some((event) => event.type === FULL_SNAPSHOT)) {
    throw new Error("the recorder never took a full snapshot");
  }
}

/** rrweb's event types. */
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;

/** Adds markup to the recorded page and returns what the recorder emitted for it. */
async function record(markup: string): Promise<string> {
  const from = emitted.length;
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.append(host);
  for (let i = 0; i < 50 && emitted.length === from; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const events = emitted.slice(from);
  expect(
    events.some((event) => event.type === INCREMENTAL),
    "the recorder emitted no mutation for the added markup",
  ).toBe(true);
  return JSON.stringify(events);
}

beforeAll(startRecording, 10_000);
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("the OPS-03 content rule against PostHog's replay payload (ADR 0002 decision 3)", () => {
  it("keeps project content out of the full snapshot of a page built from every shape", () => {
    // Text nodes, the masked accessible names, an input value and its
    // placeholder, a title, and an asset URL on an image. All at once, so this
    // is one assertion about the whole payload rather than a checklist a new
    // shape can slip past.
    const snapshot = emitted.find((event) => event.type === FULL_SNAPSHOT);
    const payload = JSON.stringify(snapshot);
    expect(payload).toContain("button");
    expectNoForbiddenContent(payload);
  });

  it("keeps it out of content added after recording started", async () => {
    expectNoForbiddenContent(
      await record(`
				<section class="${MASK_CONTENT}">
					<h2>${FORBIDDEN.projectName}</h2>
					<button aria-label="Mute ${FORBIDDEN.trackName}" title="${FORBIDDEN.clipName}">M</button>
					<input value="${FORBIDDEN.searchTerm}" />
				</section>
			`),
    );
  });

  // ADR 0003 removed the one blocked subtree, the arrangement canvas stack,
  // because blocking it is what made replay useless. So the arrangement's
  // *DOM* is recorded like any other, and masking is what keeps content out.
  it("keeps it out of the arrangement's DOM, which is not blocked", async () => {
    expectNoForbiddenContent(
      await record(`
				<div class="arrangement-canvas-stack" aria-label="${FORBIDDEN.projectName}">
					<span class="${MASK_CONTENT}">${FORBIDDEN.trackName}</span>
					<p>${FORBIDDEN.assistantText}</p>
				</div>
			`),
    );
  });

  it("keeps it out of a surface that carries no marking of its own", async () => {
    // Masking all text is the *default*, not an opt-in: a surface a later
    // task adds and forgets to mark is still masked.
    expectNoForbiddenContent(
      await record(`
				<div>
					<h2>${FORBIDDEN.projectName}</h2>
					<p>${FORBIDDEN.assistantText}</p>
					<input value="${FORBIDDEN.searchTerm}" />
					<textarea>${FORBIDDEN.clipName}</textarea>
				</div>
			`),
    );
  });

  it("keeps it out of an assistant transcript, the largest free-text surface", async () => {
    expectNoForbiddenContent(
      await record(`
				<ol class="${MASK_CONTENT}">
					<li>${FORBIDDEN.assistantText}</li>
					<li>Added a pad to ${FORBIDDEN.trackName}</li>
				</ol>
			`),
    );
  });

  it("keeps an asset URL out when the element carrying it is media, which is blocked", async () => {
    expectNoForbiddenContent(
      await record(
        `<img src="${FORBIDDEN.assetUrl}" /><audio src="${FORBIDDEN.assetUrl}"></audio>`,
      ),
    );
  });

  it("strips the query string from a URL, where a token rides", async () => {
    const payload = await record(
      `<a href="/download?token=${FORBIDDEN.token}&q=${encodeURIComponent(FORBIDDEN.searchTerm)}">Export</a>`,
    );
    expectNoForbiddenContent(payload);
    expect(payload).toContain("/download");
  });

  it("does not claim to cover canvas pixels, which are recorded unmasked", async () => {
    // ADR 0003 decision 1, stated as a checked fact rather than left as an
    // absence: this suite sees the DOM node, not what is drawn inside it.
    const payload = await record(
      `<canvas class="${MASK_CONTENT}" data-testid="arrangement-layer"></canvas>`,
    );
    expect(payload).toContain("canvas");
  });

  it("fails when a surface puts content in a data attribute", async () => {
    // The test that proves the test works, and a real gap: a `data-*`
    // attribute is not text and not a masked attribute, so the recorder emits
    // it as written. The source guard below is what keeps names out of one.
    const payload = await record(
      `<div class="${MASK_CONTENT}" data-track-name="${FORBIDDEN.trackName}"></div>`,
    );
    expect(payload).toContain(FORBIDDEN.trackName);
  });

  it("fails when a surface puts a token in a URL's path", async () => {
    // The second real gap: only the query string and fragment are stripped.
    const payload = await record(`<a href="/download/${FORBIDDEN.token}">Export</a>`);
    expect(payload).toContain(FORBIDDEN.token);
  });

  it("still records the interaction, which is the whole point of decision 1", async () => {
    // Masking must not be achieved by recording nothing: the structure, the
    // element types, and the stable chrome all survive; only characters go.
    const payload = await record(`
			<section class="${MASK_CONTENT}" data-testid="mixer-strip">
				<button type="button">Solo</button>
				<input type="range" />
			</section>
		`);

    expect(payload).toContain("button");
    expect(payload).toContain("range");
    expect(payload).toContain("mixer-strip");
  });
});

describe("network timing in a replay (GRV-120)", () => {
  // PostHog's own builder for the recorder's network options, given our
  // config and a project that has turned header and body capture *on*.
  const options = buildNetworkRequestOptions(
    {
      ...postHogInitOptions(POSTHOG_DEFAULT_HOST, "memory"),
      session_recording: { ...POSTHOG_SESSION_RECORDING },
    } as never,
    { recordHeaders: true, recordBody: true, recordPerformance: true },
  );

  it("records no headers or bodies, whatever the project setting says", () => {
    expect(options.recordHeaders).toBe(false);
    expect(options.recordBody).toBe(false);
  });

  it("records method, status and timing, and a URL with no token or name in it", () => {
    const masked = options.maskRequestFn?.({
      name: `https://firebasestorage.googleapis.com/v0/b/bucket/o/users%2Fu1%2F${encodeURIComponent(FORBIDDEN.assetName)}?alt=media&token=${FORBIDDEN.token}`,
      method: "GET",
      status: 200,
      startTime: 10,
      duration: 25,
      initiatorType: "fetch",
      requestHeaders: { authorization: `Bearer ${FORBIDDEN.token}` },
      requestBody: JSON.stringify({ name: FORBIDDEN.projectName }),
      responseBody: JSON.stringify({ clip: FORBIDDEN.clipName }),
    } as never);

    expect(masked).toMatchObject({
      method: "GET",
      status: 200,
      startTime: 10,
      duration: 25,
    });
    expectNoForbiddenContent(JSON.stringify(masked));
  });

  it("drops the query string from any other request too", () => {
    const masked = options.maskRequestFn?.({
      name: `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FORBIDDEN.token}`,
      method: "POST",
      status: 200,
    } as never);
    expect(masked?.name).toBe(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup",
    );
  });
});

describe("replay sampling agrees with PostHog's (ADR 0002 decision 6)", () => {
  it("makes the same decision as the SDK for every session", () => {
    // The loader decides first, so only a session PostHog will record loads
    // the recorder. A disagreement would load it for nothing, or record a
    // session without the recorder present.
    const ids = Array.from({ length: 1000 }, () => crypto.randomUUID());
    for (const id of ids) {
      expect(isSessionSampled(id, REPLAY_SESSION_SAMPLE_RATE), id).toBe(
        sampleOnProperty(id, REPLAY_SESSION_SAMPLE_RATE),
      );
    }
  });
});

describe("source guards for the two gaps above", () => {
  it("has no surface that binds a URL attribute to anything user-authored", () => {
    // The guard for the URL-path gap above, over the real source rather than
    // a fixture, in the same shape as the `data-*` allowlist below.
    // Static URLs are not listed — a literal in our own source is our string,
    // not the user's. Only *bound* expressions can carry content.
    const allowed = [
      // A PRD section 9.4 prefixed project ID in a route. Opaque by
      // construction, and specifically not the project's name. Listed by the
      // expression it interpolates, since the literal wrapper is stripped
      // below.
      "project.id",
      // ...the same ID, read through the accessor a keyed `For` hands its row.
      "project().id",
      // A caller-supplied route constant with a static fallback.
      'props.homeHref ?? "/projects"',
      // The landing page's start destination: a module-level constant in
      // `LandingPageContent.tsx` holding the literal "/projects". Bound rather
      // than repeated inline because three controls share it.
      "START_HREF",
      // The view dock's addresses (UI-001). `props.href` is handed
      // `editorViewPath(projectId, view)` — a prefixed project ID and one of
      // three fixed segments — so the URL is built entirely from opaque IDs
      // and our own literals, never from a project, track, or clip name.
      "props.href(spec.view)",
      // ...and the function `EditorView` hands it, which is
      // `editorViewPath(projectId, view)` with the id closed over.
      "props.viewHref",
      // The site's own public origin, from `site.config.mjs`, in the
      // prerendered shell's canonical URL. A build-time constant, and the
      // shell is not a surface a session replay can record in the first place.
      "SITE_ORIGIN",
      // The request-access form's address (#854), a build-time constant in
      // `site.config.mjs`, also bound through the landing page's own alias.
      // It names no person and carries no token.
      "requestAccessUrl",
      "REQUEST_ACCESS_HREF",
      // The home page's own pictures (#1135): `ASSETS` is the literal
      // "/landing" and `row.image` a file name from the page's own constant
      // `STUDIO_ROWS`; `INSIDE_ID` is the literal "inside", an in-page
      // anchor. Our own static files, never a user's asset or a token.
      "ASSETS",
      "row.image",
      "INSIDE_ID",
      // The assistant card's control links (GRV-5): `#control:` and a control
      // key, which is a prefixed entity ID (or the song or master) and a
      // parameter key from our own registry. Never a name or a value.
      "controlHref(props.address)",
      // A tutorial video's player and watch page (GRV-16): built from an
      // 11-character YouTube video ID the model named and YouTube vouched
      // for, a public identifier of a public video. Never a string the user
      // typed, an asset URL or a token. The terms and privacy links are our
      // own constants.
      "youtubeEmbedUrl(props.video.videoId)",
      "youtubeWatchUrl(props.video.videoId)",
      "YOUTUBE_TERMS_URL",
      "GOOGLE_PRIVACY_URL",
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      // `(?<![-\w])` so `data-action=` and `data-available=` are not read as
      // the `object[data]` attribute, and a template literal's `${…}` is
      // allowed one level of nesting so `` `/projects/${id}` `` matches whole.
      for (const match of source.matchAll(
        /(?<![-\w])(?:href|src|srcset|poster|action|data)=\{((?:[^{}]|\$\{[^{}]*\})*)\}/g,
      )) {
        for (const bound of boundExpressions(match[1].trim())) {
          if (!allowed.includes(bound)) {
            offenders.push(`${relative(sourceRoot, file)}: ={${bound}}`);
          }
        }
      }
    }
    expect(
      offenders,
      "a URL attribute bound to an expression that is not on the allowlist. " +
        "The replay recorder keeps a URL's path, and only its query string " +
        "and fragment are stripped (ADR 0002 decision 3). An asset URL or a " +
        "token placed in the path reaches the payload. Use an opaque prefixed " +
        "ID, or add it here with the reason it carries no content.",
    ).toEqual([]);
  });

  it("has no surface that puts user content in a data attribute today", () => {
    // The guard for the gap above, over the real source rather than a fixture,
    // so it covers surfaces a later task adds. Every `data-*` the app binds
    // dynamically must carry a prefixed ID, a revision, an enum, or a release
    // SHA — never a name, a search term, or anything else a user authored.
    //
    // Kept as an allowlist of *bound expressions* rather than a scan for bad
    // values, because the bad values are only knowable at runtime: the
    // question is what a surface is allowed to put there at all.
    const allowed = [
      // PRD section 9.4 prefixed IDs. Opaque by construction.
      "props.note.id",
      "track.id",
      // The same `TrackId`, read through a `<For>` row keyed on it (#447).
      "track().id",
      // A mixer strip's `TrackId`, which the track drag (TRK-02) reads its
      // items by — the same prefixed ID as `track.id`, reached through props.
      "props.track.id",
      // The instrument rail's rows, as drag items (#447): the same prefixed
      // `TrackId`, bound only while the rail can be reordered.
      "props.onReorder ? track().id : undefined",
      // A device card's `DeviceId`, which the chain's reorder drag (#539)
      // reads its items by: a prefixed ID like `track.id`, never the name.
      "device().id",
      // The mixer's previewed strip (TRK-02): a fixed test id or nothing,
      // never anything the user authored.
      'props.previewing ? "track-drop-indicator" : undefined',
      // The `PlacementId`s of the placement-editing selection (ARR-002), in
      // the arrangement's accessible mirror. A prefixed ID like the two above
      // — the placement's *name* is never bound here, and the mirror's own
      // track names are text inside `MASK_CONTENT`.
      "placementId",
      // A save state enum and its integer revision.
      "props.saveStatus()?.state",
      "props.saveStatus()?.revision",
      // The deployed revision, which is our code's identity, not the user's.
      "RELEASE_SHA",
      // The arrangement's horizontal scale in pixels per tick: a rendering
      // number of our own, published so a browser test can aim a gesture at a
      // clip drawn on a canvas.
      "pixelsPerTick()",
      // Shortcut registry facts: a static action ID and a boolean.
      "row.shortcut.id",
      "String(row.available)",
      // The arrangement's previewed header row (TRK-02): a fixed test id or
      // nothing, never anything the user authored.
      'previewing(track().id) ? "track-drop-indicator" : undefined',
      // The Export ZIP gutter's bracket state (#724): an enum of our own
      // ("current", "done" or none). Never a name.
      "bracket.state",
      // The assistant panel's mode (#849): floating, minimised, docked or
      // closed, an enum of our own.
      "props.panel.layout().mode",
      // My packs (#282): a drop target's state ("none", "accepted",
      // "refused") and an import row's ("uploading", "failed", "cancelled").
      // Enums of our own; the file's and the pack's names are masked text.
      "drop.state()",
      "emptySpace.state()",
      "props.row.state",
      // A library family tile's unit word (GRV-49): "sound" or "sounds",
      // chosen by the count. Our own copy, never a name.
      'entry.count === 1 ? "sound" : "sounds"',
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bdata-[a-z-]+=\{([^}]+)\}/g)) {
        const bound = match[1].trim();
        if (!allowed.includes(bound)) {
          offenders.push(`${relative(sourceRoot, file)}: data-…={${bound}}`);
        }
      }
    }
    expect(
      offenders,
      "a data attribute bound to something not on the allowlist. The " +
        "replay recorder does not mask data-* attributes, so anything " +
        "user-authored placed there reaches the payload (ADR 0002 decision 3). " +
        "Render it as text inside a masked element instead, or add it here " +
        "with the reason it carries no content.",
    ).toEqual([]);
  });
});
