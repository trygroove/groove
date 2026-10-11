// ADR 0002 decision 3: "The `OPS-03` content rule extends to the replay
// payload. 'No project content, assistant text, user-entered strings, asset
// URLs, or tokens' already governs events and breadcrumbs. It now governs
// replays, and is enforced the same way — positively, by test, against the
// serialized payload rather than by inspection of the configuration."
//
// `scrub.test.ts` does that for events by planting every forbidden value into a
// hostile payload and asserting none of them survive *serialization*. This file
// is the same move for replay, and the reason it is a separate file is that the
// payload is a different thing: a replay is a serialized **DOM**, not a JSON
// event, and it is masked at capture rather than filtered on send.
//
// ## Why this is a real test and not a restatement of the configuration
//
// Asserting `maskAllText: true` — which `sentrySink.test.ts` does — proves the
// SDK was *told* to mask. It does not prove that a page built out of Solid
// Groove's own surfaces yields a payload with no project content in it, and
// those are different claims: text is not the only place content lives. A track
// name reaches the DOM through an `aria-label`, a `title`, a `value`, a
// `placeholder`, an `alt`, a `data-*` attribute, and an asset URL reaches it
// through `src` and `href` — none of which are text nodes, and several of which
// masking does not touch. So this builds a hostile document out of exactly those
// shapes and asserts against the serialized result.
//
// ## The model must never be stronger than the recorder
//
// Sentry's recorder is not run here — it is not importable outside
// `sentrySink.ts` (ADR 0001 decision 1), and running rrweb in jsdom would test
// rrweb rather than our surfaces. So masking is modelled, and the *direction* of
// that model is the property this whole file depends on.
//
// A model that masks **more** than the SDK does not fail safe. It certifies as
// clean a payload shape the real recorder would transmit in full, which is worse
// than having no test, because the acceptance box gets ticked on it. Every rule
// in `serializeUnderMasking` is therefore pinned to what `@sentry/replay`
// actually does:
//
// - `maskAttributes` defaults to exactly `["title", "placeholder", "aria-label"]`
//   and nothing else. `aria-description`, `aria-valuetext`, `alt`, `label` and
//   `download` are *not* masked — they reach the payload as written.
// - `transformAttribute` returns `src` and `href` early through `absoluteToDoc`
//   **before** the masking function is ever consulted, so a URL attribute is
//   resolved to absolute and emitted verbatim, query string included. `srcset`,
//   `poster` and `object[data]` take the same early exit.
// - `maskAllInputs` masks an input's `value`.
//
// What genuinely keeps asset URLs out is `blockAllMedia`, which blocks the SDK's
// `MEDIA_SELECTORS` outright, plus our own `BLOCK_CONTENT` subtrees. Those are
// modelled as blocked because they really are.
//
// So an `<a href>` or an unblocked `src` carrying a token *does* leak, and this
// file says so in a test rather than masking it away. The guards for that and
// for `data-*` scan the real source: the value is only knowable at runtime, so
// the question is what a surface may bind there at all.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MASK_CONTENT } from "./replayPrivacy";

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
 * The SDK's `maskAttributes` default, verbatim — not a list of attributes we
 * wish were masked. Widening it here would make this file certify payloads the
 * recorder does not actually clean.
 */
const MASKED_ATTRIBUTES = ["title", "placeholder", "aria-label"];

/**
 * The elements `blockAllMedia` blocks, from the SDK's `MEDIA_SELECTORS`. Their
 * subtrees and attributes — `src` included — never reach the payload.
 */
const MEDIA_TAGS = [
  "img",
  "image",
  "svg",
  "video",
  "object",
  "picture",
  "embed",
  "map",
  "audio",
];

/**
 * What the recorder would serialize for this tree, under our configuration.
 *
 * Models the capture-time rules ADR 0002 decision 2 rests on, as revised by
 * ADR 0003:
 *
 * - an element matching `blockAllMedia`'s selectors is replaced by a
 *   placeholder box: no children, no attributes. `BLOCK_CONTENT` is gone —
 *   ADR 0003 removed the one blocked subtree, so media is the only block now;
 * - `maskAllText` masks every text node — the default is masked, and nothing in
 *   `REPLAY_PRIVACY` names an unmasked exception;
 * - `maskAllInputs` masks an input's `value`;
 * - `maskAttributes` masks `title`, `placeholder`, and `aria-label`;
 * - **every other attribute is serialized verbatim**, URL attributes included,
 *   because `transformAttribute` returns them before masking is consulted.
 *
 * The last rule is the one that makes this test able to find a leak instead of
 * papering over it.
 *
 * What this model deliberately does **not** cover: `<canvas>` pixels. ADR 0003
 * turns canvas capture on, and no masking rule reaches inside a canvas — the
 * arrangement's clips, notes, waveforms, and section names are recorded as
 * drawn. That is the decision, not a leak, so the assertions below are about
 * the DOM payload only. `canvasRecordsUnmasked` pins it explicitly rather than
 * leaving the omission to be read as an oversight.
 */
function serializeUnderMasking(root: Element): string {
  const node = (element: Element): unknown => {
    const tag = element.tagName.toLowerCase();
    if (MEDIA_TAGS.includes(tag)) {
      // Blocked: a placeholder box, carrying neither children nor attributes.
      return { tag, blocked: true };
    }
    const attributes: Record<string, string> = {};
    for (const attribute of element.attributes) {
      const name = attribute.name;
      const masksInputValue = name === "value" && tag === "input";
      attributes[name] =
        MASKED_ATTRIBUTES.includes(name) || masksInputValue
          ? mask(attribute.value)
          : attribute.value;
    }
    return {
      tag,
      attributes,
      // `maskAllText`: every text node's characters are replaced at capture.
      text: [...element.childNodes]
        .filter((child) => child.nodeType === 3)
        .map((child) => mask(child.textContent ?? "")),
      children: [...element.children].map(node),
    };
  };
  return JSON.stringify(node(root));
}

/** Sentry replaces each character of masked text with `*`. */
function mask(value: string): string {
  return "*".repeat(value.length);
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

function html(markup: string): Element {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
}

describe("the OPS-03 content rule against the replay payload (ADR 0002 decision 3)", () => {
  it("keeps project content out of a payload built from every shape a surface uses", () => {
    // Every way our surfaces put content into the DOM that the recorder
    // genuinely cleans: text nodes, the three masked accessible names, an
    // input value, and an asset URL on a `blockAllMedia`-blocked `<img>`. All
    // at once, so this is one assertion about the whole payload rather than a
    // checklist a new shape can slip past.
    //
    // The shapes it does *not* clean — an unmasked `href`, an `alt` — are
    // deliberately absent, and covered by the source guards below. Passing
    // with them here would require the model to mask what the SDK does not.
    const surface = html(`
			<section class="${MASK_CONTENT}">
				<h1>${FORBIDDEN.projectName}</h1>
				<button aria-label="Rename ${FORBIDDEN.trackName}">Rename</button>
				<input value="${FORBIDDEN.clipName}" placeholder="${FORBIDDEN.searchTerm}" />
				<span title="${FORBIDDEN.assetName}">Sample</span>
				<img alt="${FORBIDDEN.trackName}" src="${FORBIDDEN.assetUrl}" />
				<p>${FORBIDDEN.assistantText}</p>
			</section>
		`);

    expectNoForbiddenContent(serializeUnderMasking(surface));
  });

  // ADR 0003 removed the one blocked subtree — the arrangement canvas stack —
  // because blocking it is what made replay useless. So the arrangement's
  // *DOM* is now recorded like any other, and the rule that keeps content out
  // of it is masking, not blocking. This is the replacement for the old
  // "blocked subtree" case, and it is a stricter test: the content has to
  // survive masking rather than being skipped wholesale.
  it("keeps it out of the arrangement's DOM, which is no longer blocked", () => {
    const surface = html(`
			<div class="arrangement-canvas-stack" aria-label="${FORBIDDEN.projectName}">
				<span class="${MASK_CONTENT}">${FORBIDDEN.trackName}</span>
				<p>${FORBIDDEN.assistantText}</p>
			</div>
		`);

    expectNoForbiddenContent(serializeUnderMasking(surface));
  });

  it("keeps it out of a surface that carries no marking of its own", () => {
    // The point of `maskAllText` being the *default* rather than an opt-in: a
    // surface a later task adds and forgets to mark is still masked. The
    // component-level marking is the second safeguard, not the only one, and
    // `replayPrivacy.test.ts` is what stops that second one rotting.
    const surface = html(`
			<div>
				<h2>${FORBIDDEN.projectName}</h2>
				<p>${FORBIDDEN.assistantText}</p>
				<input value="${FORBIDDEN.searchTerm}" />
			</div>
		`);

    expectNoForbiddenContent(serializeUnderMasking(surface));
  });

  it("keeps it out of an assistant transcript, the largest free-text surface", () => {
    const surface = html(`
			<ol class="${MASK_CONTENT}">
				<li>${FORBIDDEN.assistantText}</li>
				<li>Added a pad to ${FORBIDDEN.trackName}</li>
			</ol>
		`);

    expectNoForbiddenContent(serializeUnderMasking(surface));
  });

  // ADR 0003 decision 1, stated as a checked fact rather than left as an
  // absence. Canvas capture is on and masking has no reach inside a canvas, so
  // what the arrangement renderer draws — clips, notes, waveforms, and the
  // user-authored section names at `canvasRenderer.ts` — is recorded as drawn.
  // This suite models the DOM payload and cannot see those pixels, which is
  // exactly why the limit is written down here: a reader must not take "the
  // payload tests pass" as "no project content reaches Sentry".
  it("does not claim to cover canvas pixels, which are recorded unmasked", () => {
    const surface = html(
      `<canvas class="${MASK_CONTENT}" data-testid="arrangement-layer"></canvas>`,
    );

    // The DOM node masks like anything else — and says nothing at all about
    // the pixels inside it, which the canvas integration records verbatim.
    const serialized = serializeUnderMasking(surface);
    expect(serialized).toContain("canvas");
    expect(serialized).not.toContain(FORBIDDEN.clipName);
  });

  it("fails when a surface puts content in a data attribute", () => {
    // The test that proves the test works, and a real gap rather than a model
    // artifact: a `data-*` attribute is not text and not one of the three
    // masked attributes, so neither this model nor Sentry's recorder masks it.
    // A surface stashing a clip name there leaks it, and this file has to be
    // able to say so rather than passing because the page looked masked.
    const leaky = html(
      `<div class="${MASK_CONTENT}" data-track-name="${FORBIDDEN.trackName}"></div>`,
    );

    expect(serializeUnderMasking(leaky)).toContain(FORBIDDEN.trackName);
  });

  it("fails when a surface puts a token or an asset URL in an href", () => {
    // The second real gap, and the one an earlier version of this file hid by
    // masking `href` in the model. Masking the element does nothing for it:
    // `MASK_CONTENT` governs text, not URLs.
    const leaky = html(
      `<a class="${MASK_CONTENT}" href="/download?token=${FORBIDDEN.token}">Export</a>`,
    );

    expect(serializeUnderMasking(leaky)).toContain(FORBIDDEN.token);
  });

  it("keeps an asset URL out when the element carrying it is media, which is blocked", () => {
    // Why the `<img src>` above is safe while the `<a href>` is not:
    // `blockAllMedia` blocks the element outright, so its attributes never
    // reach the payload. The protection is the block, not the masking — which
    // is why moving an asset URL onto a non-media element would break it.
    const media = html(`<img src="${FORBIDDEN.assetUrl}" />`);

    expectNoForbiddenContent(serializeUnderMasking(media));
  });

  it("has no surface that binds a URL attribute to anything user-authored", () => {
    // The guard for the `href`/`src` gap above, over the real source rather
    // than a fixture, in the same shape as the `data-*` allowlist below.
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
        "Sentry's replay recorder resolves `src` and `href` to absolute URLs " +
        "and serializes them verbatim — masking never sees them (ADR 0002 " +
        "decision 3). An asset URL or a token placed there reaches the " +
        "payload. Use an opaque prefixed ID, or add it here with the reason " +
        "it carries no content.",
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
      "a data attribute bound to something not on the allowlist. Sentry's " +
        "replay recorder does not mask data-* attributes, so anything " +
        "user-authored placed there reaches the payload (ADR 0002 decision 3). " +
        "Render it as text inside a masked element instead, or add it here " +
        "with the reason it carries no content.",
    ).toEqual([]);
  });

  it("still records the interaction, which is the whole point of decision 1", () => {
    // Masking must not be achieved by recording nothing. Replay exists to show
    // which controls were used and how the user moved through the app, so the
    // structure, the element types, and the stable chrome all survive — only
    // the characters go.
    const payload = serializeUnderMasking(
      html(`
				<section class="${MASK_CONTENT}" data-testid="mixer-strip">
					<button type="button">Solo</button>
					<input type="range" />
				</section>
			`),
    );

    expect(payload).toContain("button");
    expect(payload).toContain("range");
    expect(payload).toContain("mixer-strip");
  });
});
