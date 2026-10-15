// ADR 0002 decision 2 asks that a surface rendering user-authored content be
// marked at the component level, so it is masked "by the default *and* by its
// own markup". That is only worth anything if something checks it: the global
// `maskAllText` default lives in one file and can be weakened from a distance
// — an SDK upgrade, an unmask selector added to make a replay readable, a
// later decision to relax it. The first table below is what stops the
// component-level marking rotting as surfaces move.
//
// The second table has the opposite job, which matters as much. Decision 1
// says replay exists to show where people get stuck, and a replay of grey
// blocks shows nothing, so it pins the surfaces deliberately *not* marked —
// the arrangement canvas, a mixer strip, the piano roll — and fails if a later
// change re-broadens masking over them. One policy read from both ends: mask
// the names, keep the interface.
//
// Both read source rather than rendering components: the question is
// structural, the answer must cover surfaces a later task adds, and rendering
// these panels would need a project fixture, an audio runtime, and a router.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative as relativeTo } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSessionSampled,
  MASK_ALL_TEXT_SELECTOR,
  MASK_ATTRIBUTES,
  MASK_CONTENT,
  maskReplayAttribute,
  maskReplayNetworkRequest,
  maskReplayText,
  REPLAY_SESSION_SAMPLE_RATE,
  REPLAY_UNMASK_SELECTORS,
} from "./replayPrivacy";

const sourceRoot = join(process.cwd(), "src");

function read(relative: string): string {
  return readFileSync(join(sourceRoot, relative), "utf8");
}

function componentFiles(directory: string = sourceRoot): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return componentFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * The end of the JSX opening tag starting at `start`, or -1.
 *
 * Scoping to one tag is what makes an assertion about *this element* rather
 * than about the file. A prop is full of characters that look like the tag's
 * end and are not — `>` in an arrow function, an apostrophe in a comment, a `/`
 * that opens a comment — so this skips strings and comments and ends the tag
 * only on a `>` outside them at brace depth zero.
 */
function tagEnd(source: string, start: number): number {
  type Skip = '"' | "'" | "`" | "line" | "block" | null;
  let depth = 0;
  let skipping: Skip = null;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (skipping === "line") {
      if (char === "\n") skipping = null;
      continue;
    }
    if (skipping === "block") {
      if (char === "*" && next === "/") {
        skipping = null;
        i++;
      }
      continue;
    }
    if (skipping) {
      if (char === skipping) skipping = null;
      continue;
    }
    if (char === "/" && next === "/") skipping = "line";
    else if (char === "/" && next === "*") skipping = "block";
    else if (char === '"' || char === "'" || char === "`") skipping = char;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Every JSX opening tag containing `anchor`, as raw source. Every occurrence,
 * not the first: a class name that also appears in a comment at the top of its
 * file (`.library-search` is discussed in one) would otherwise be looked for in
 * whatever tag happened to precede that prose.
 */
function openingTagsAround(source: string, anchor: string): string[] {
  const tags: string[] = [];
  for (let at = source.indexOf(anchor); at !== -1; ) {
    const start = source.lastIndexOf("<", at);
    const end = start === -1 ? -1 : tagEnd(source, start);
    if (start !== -1 && end > at) tags.push(source.slice(start, end));
    at = source.indexOf(anchor, at + anchor.length);
  }
  return tags;
}

/**
 * Every element that renders a string a user typed, with the anchor its
 * marking sits on.
 *
 * The bar for a row is narrow and deliberate: a project name, a track name, a
 * clip name (schema v1's only user-writable `name` fields), or the live
 * contents of a text input. An asset, pad, or pack name is a library fact we
 * ship, and masking it would hide which sound someone reached for — the exact
 * behaviour replay is there to observe. Adding a surface that shows one of
 * those three names, or that accepts typed text, means adding it here.
 */
const MASKED_NAMES: readonly {
  readonly file: string;
  readonly anchor: string;
  readonly renders: string;
}[] = [
  {
    file: "components/ProjectList.tsx",
    anchor: "project-title",
    renders: "a project's name on the dashboard",
  },
  {
    file: "components/ProjectList.tsx",
    anchor: "project-rename-input",
    renders: "the new project name as it is typed",
  },
  {
    file: "editor/EditorHeader.tsx",
    anchor: "project-name",
    renders: "the open project's name",
  },
  {
    file: "editor/ProjectNameInput.tsx",
    anchor: "project-name-input",
    renders: "the project name as it is typed",
  },
  {
    // The one rename input the mixer strip and the track header share.
    file: "editor/TrackNameInput.tsx",
    anchor: "track-name-",
    renders: "the track name, editable in place",
  },
  {
    file: "editor/ReturnStrip.tsx",
    anchor: "return-name-",
    renders: "a return bus's name, editable in place on its mixer strip",
  },
  {
    file: "editor/ReturnPanel.tsx",
    anchor: "instrument-return-name",
    renders: "the selected return's name atop the instrument view's return mode",
  },
  {
    file: "editor/TrackSends.tsx",
    anchor: "mixer-send-name",
    renders: "the return a track's send feeds, on the track's mixer strip",
  },
  {
    file: "editor/InstrumentHeader.tsx",
    anchor: "instrument-header-name",
    renders: "the track's name atop the instrument view",
  },
  {
    file: "editor/DrumMachinePanel.tsx",
    anchor: "pad-sample",
    renders: "the sound each pad plays, down the pad table",
  },
  {
    file: "editor/TrackHeader.tsx",
    anchor: "track-header-name",
    renders: "track names down the arrangement's header column and the rail",
  },
  {
    file: "arrangement/ArrangementView.tsx",
    anchor: "arrangement-selection-live",
    renders: "the selected track's name, announced to assistive tech",
  },
  {
    file: "arrangement/ArrangementView.tsx",
    anchor: "Arrangement tracks",
    renders: "track names in the arrangement's accessible mirror",
  },
  {
    file: "editor/LibraryModal.tsx",
    anchor: "library-modal-search",
    renders: "the sound search the user typed",
  },
  {
    file: "components/ConfirmDialog.tsx",
    anchor: "confirm-dialog-title",
    renders: "a project or track name in a delete confirmation",
  },
];

/**
 * Surfaces that stay unmarked, pinned so masking cannot creep back over them.
 *
 * Each is a container whose *contents* are the product — the arrangement's
 * clips, a mixer strip's faders, the piano roll's notes. Most render no
 * user-authored name directly; where one is nested inside, it carries its own
 * marking above. The literal `class="…"` is the assertion: re-broadening
 * masking to one of these means turning it into a template literal, and this
 * fails on that.
 *
 * `arrangement-canvas-stack` is the exception worth stating plainly. It *does*
 * carry user-authored section names, drawn into the canvas by
 * `arrangement/canvasRenderer.ts`, and ADR 0003 turns canvas capture on — so
 * those names are recorded. Masking cannot reach inside a canvas anyway; the
 * disclosure covers it instead of a mark that would do nothing.
 */
const DELIBERATELY_UNMARKED: readonly {
  readonly file: string;
  readonly literal: string;
}[] = [
  {
    file: "arrangement/ArrangementView.tsx",
    literal: 'class="arrangement-canvas-stack"',
  },
  {
    file: "arrangement/ArrangementView.tsx",
    literal: 'class="arrangement-headers"',
  },
  {
    file: "editor/Mixer.tsx",
    // Pinned as the bare quoted class name rather than `class="mixer-strip"`.
    // Solid 2 removed `classList`, so a static class and its conditional
    // siblings can no longer be two attributes -- they merge into one
    // `class={["mixer-strip", { muted, selected }]}` array, and the old
    // `class="..."` spelling cannot exist here any more. The property this
    // assertion actually rests on is unchanged and is why the quotes are part
    // of the literal: re-broadening masking over this surface means
    // interpolating into a template literal, and a template literal contains
    // no `"mixer-strip"`. The surface itself is as unmarked as it ever was.
    literal: '"mixer-strip",',
  },
  {
    file: "components/ProjectList.tsx",
    literal: 'class="project-row"',
  },
  {
    file: "editor/pianoRoll/PianoRoll.tsx",
    literal: 'class="piano-roll"',
  },
  {
    file: "editor/StepEditor.tsx",
    literal: 'class="step-lane"',
  },
  {
    file: "editor/LoopInfo.tsx",
    literal: 'class="loop-asset"',
  },
  {
    file: "instrument/SamplerPanel.tsx",
    // The sample group carries a layout class of its own; the pin follows the
    // markup so it keeps asserting what it is for — a plain, unmasked string
    // literal, which turning masking back on would have to replace with a
    // template literal.
    literal: 'class="instrument-panel-group sampler-sample-group"',
  },
  // The title beside it *is* masked (see MASKED_NAMES). The message is fixed
  // explanatory copy, and a delete confirmation is friction worth observing.
  {
    file: "components/ConfirmDialog.tsx",
    literal: 'class="confirm-dialog-message"',
  },
];

describe("user-authored names are masked (ADR 0002 decision 2)", () => {
  for (const surface of MASKED_NAMES) {
    it(`masks ${surface.anchor} in ${surface.file}, which renders ${surface.renders}`, () => {
      const tags = openingTagsAround(read(surface.file), surface.anchor);
      expect(
        tags.length,
        `"${surface.anchor}" was not found on an element in ${surface.file}`,
      ).toBeGreaterThan(0);
      expect(
        tags.some((tag) => tag.includes("MASK_CONTENT")),
        `"${surface.anchor}" in ${surface.file} renders ${surface.renders} ` +
          `but does not carry ${MASK_CONTENT}. ADR 0002 decision 2 requires ` +
          "a surface rendering user-authored content to be masked by its own " +
          "markup as well as by the global default.",
      ).toBe(true);
    });
  }

  it("imports the marking from this module rather than writing the class inline", () => {
    // A hand-written "ph-mask" string would not be found by a rename and
    // would not be found by the check above either.
    for (const file of new Set(MASKED_NAMES.map((s) => s.file))) {
      expect(read(file), `${file} should import its marking`).toContain(
        'from "../monitoring/replayPrivacy"',
      );
    }
  });
});

describe("the interface stays visible (ADR 0002 decision 1)", () => {
  for (const surface of DELIBERATELY_UNMARKED) {
    it(`leaves ${surface.literal} in ${surface.file} unmarked`, () => {
      const source = read(surface.file);

      // Half one: the surface still exists under the name this row pins.
      expect(
        source,
        `${surface.literal} in ${surface.file} is gone. If it was renamed, ` +
          "update this row; if it was removed, remove the row.",
      ).toContain(surface.literal);

      // Half two, and the half that actually holds ADR 0002 decision 1: the
      // element carries no masking. Stated as the *absence of MASK_CONTENT*
      // rather than as the presence of a particular spelling, deliberately.
      // A spelling pin is only fail-closed while masking cannot be added
      // without disturbing it. That held while `class="..."` was a plain
      // attribute and `classList` carried the conditional half; with Solid 2's
      // array form, appending MASK_CONTENT beside the class name is both
      // possible and the natural edit, so a spelling pin would keep passing
      // while the surface went dark. Fail-open is the one thing a privacy
      // guard must never be. This mirrors how MASKED_NAMES asserts the
      // opposite property, so the two suites now fail for the same reason in
      // opposite directions.
      // The literal, not a bare class name, is what locates the tag: this
      // file also pins `mixer-strip-name`, which *is* masked, and a substring
      // match on "mixer-strip" would find it and fail for the wrong reason.
      const tags = openingTagsAround(source, surface.literal);
      expect(
        tags.length,
        `${surface.literal} was not found on an element in ${surface.file}`,
      ).toBeGreaterThan(0);
      expect(
        tags.some((tag) => tag.includes("MASK_CONTENT")),
        `${surface.literal} in ${surface.file} now carries ${MASK_CONTENT}. ` +
          "It is unmarked on purpose: replay is worth having only while the " +
          "interface around a masked name stays legible (ADR 0002 decision 1).",
      ).toBe(false);
    });
  }
});

/**
 * Every dynamic attribute on a *DOM* element whose value interpolates a
 * `.name`, across `src/**\/*.tsx`.
 *
 * A JSX attribute on a capitalised tag is a component prop, not an attribute —
 * `<ConfirmDialog message={...}>` becomes text, `<FillSlider ariaLabel={...}>`
 * becomes an `aria-label` on the DOM element the slider renders, and that
 * element is caught here in its own right. Only a lower-case tag puts the
 * attribute into the recording under the name written here.
 */
function nameBearingAttributes(): { attribute: string; where: string }[] {
  const attribute = /([A-Za-z][A-Za-z-]*)=\{((?:[^{}`]|`[^`]*`|\{[^{}]*\})*)\}/g;
  const found: { attribute: string; where: string }[] = [];
  for (const path of componentFiles()) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(attribute)) {
      if (!/\.name\b/.test(match[2])) continue;
      const tagAt = source.lastIndexOf("<", match.index);
      const tag = source.slice(tagAt + 1).match(/^[A-Za-z][\w.]*/)?.[0] ?? "";
      if (!/^[a-z]/.test(tag)) continue;
      found.push({
        attribute: match[1],
        where: `<${tag} ${match[1]}> in ${relativeTo(sourceRoot, path)}`,
      });
    }
  }
  return found;
}

/**
 * `value` on an input is a name — the mixer's rename field — and is not in
 * `MASK_ATTRIBUTES` because `maskAllInputs` already covers an input's value at
 * capture. Listing it as an attribute as well would be a second name for the
 * same protection.
 */
const MASKED_ELSEWHERE = ["value"];

describe("names in attributes are masked (ADR 0002 decision 2)", () => {
  it("masks aria-label, which is where names reach the DOM", () => {
    expect(MASK_ATTRIBUTES).toContain("aria-label");
  });

  it("keeps the SDK's own defaults, which this list replaces", () => {
    // `maskAttributes` overrides rather than extends, so adding one attribute
    // without these would unmask two.
    expect(MASK_ATTRIBUTES).toContain("title");
    expect(MASK_ATTRIBUTES).toContain("placeholder");
  });

  it("covers every attribute a name is interpolated into", () => {
    const uncovered = nameBearingAttributes().filter(
      (hit) =>
        !MASK_ATTRIBUTES.includes(hit.attribute) &&
        !MASKED_ELSEWHERE.includes(hit.attribute),
    );
    expect(
      uncovered.map((hit) => hit.where),
      "These attributes are built from a name and are recorded verbatim: " +
        "attribute masking is by attribute name, so no class on the element " +
        "covers them. Add the attribute to MASK_ATTRIBUTES, or build the " +
        "value without the name.",
    ).toEqual([]);
  });

  it("finds the attributes it is scanning for", () => {
    // The scan is a regex over source; if it silently matched nothing, the
    // check above would pass by finding no work to do.
    expect(nameBearingAttributes().length).toBeGreaterThan(10);
  });
});

describe("nothing unmasks itself (ADR 0002 decision 2)", () => {
  it("exposes the mask class PostHog's recorder looks for by default", () => {
    // Named as a string rather than imported from the SDK, so
    // `posthogTransport.ts` stays the only module importing `posthog-js`.
    expect(MASK_CONTENT).toBe("ph-mask");
  });

  it("masks every text node, and names no exception", () => {
    // Unmasking is permitted only for stable, non-user-authored chrome, and
    // only by an explicit selector in `REPLAY_UNMASK_SELECTORS` — never by a
    // component deciding for itself that its own content is safe to record.
    expect(MASK_ALL_TEXT_SELECTOR).toBe("*");
    expect(REPLAY_UNMASK_SELECTORS).toEqual([]);
  });

  it("has no component that tells the recorder to skip its masking", () => {
    // PostHog's recorder has no unmask class; the classes that change what it
    // records are its block and ignore classes, and no surface may use them
    // to opt out of masking either.
    const offenders: string[] = [];
    for (const path of componentFiles()) {
      const source = readFileSync(path, "utf8");
      if (/ph-unmask|ph-ignore-input|sentry-unmask/.test(source)) {
        offenders.push(relativeTo(sourceRoot, path));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the recorder's masking functions (GRV-120)", () => {
  it("masks every visible character of a text node and keeps its spacing", () => {
    const element = document.createElement("p");
    expect(maskReplayText("Midnight Drive", element)).toBe("******** *****");
  });

  it("masks the attributes names reach the DOM through", () => {
    expect(maskReplayAttribute("aria-label", "Mute Lead Vocal")).toBe("**** **** *****");
    expect(maskReplayAttribute("title", "Chorus Riff")).toBe("****** ****");
    expect(maskReplayAttribute("placeholder", "dusty piano")).toBe("***** *****");
  });

  it("strips the query string and fragment from every URL attribute", () => {
    expect(maskReplayAttribute("href", "/download?token=abc#x")).toBe("/download");
    expect(
      maskReplayAttribute("src", "https://cdn.example/k.wav?alt=media&token=t"),
    ).toBe("https://cdn.example/k.wav");
    expect(maskReplayAttribute("srcset", "/a.png?t=1 1x, /b.png?t=2 2x")).toBe(
      "/a.png 1x, /b.png 2x",
    );
  });

  it("leaves other attributes alone, so the interface stays legible", () => {
    expect(maskReplayAttribute("class", "mixer-strip")).toBe("mixer-strip");
    expect(maskReplayAttribute("data-testid", "mixer-strip")).toBe("mixer-strip");
  });

  it("keeps a request's method, status and timing, and nothing of its payload", () => {
    const masked = maskReplayNetworkRequest({
      name: "https://firebasestorage.googleapis.com/v0/b/bucket/o/users%2Fu1%2Fkick.wav?alt=media&token=secret",
      method: "GET",
      status: 200,
      startTime: 1,
      duration: 20,
      requestHeaders: { authorization: "Bearer secret" },
      requestBody: "secret body",
      responseHeaders: { "set-cookie": "secret" },
      responseBody: "secret response",
    });
    expect(masked).toEqual({
      name: "https://firebasestorage.googleapis.com/v0/b/:param/o/:param/:param/:param",
      method: "GET",
      status: 200,
      startTime: 1,
      duration: 20,
    });
  });

  it("drops a request whose URL it cannot read", () => {
    expect(maskReplayNetworkRequest({ name: "not a url" })).toBeUndefined();
    expect(maskReplayNetworkRequest({})).toBeUndefined();
  });
});

describe("replay sampling (ADR 0002 decision 6)", () => {
  it("samples sessions low", () => {
    expect(REPLAY_SESSION_SAMPLE_RATE).toBe(0.1);
  });

  it("samples about that share of sessions, the same way for the same session", () => {
    const ids = Array.from(
      { length: 2000 },
      (_, i) => `0199${i.toString(16).padStart(8, "0")}-session`,
    );
    const sampled = ids.filter((id) => isSessionSampled(id, REPLAY_SESSION_SAMPLE_RATE));
    expect(sampled.length / ids.length).toBeGreaterThan(0.05);
    expect(sampled.length / ids.length).toBeLessThan(0.15);
    for (const id of ids.slice(0, 50)) {
      expect(isSessionSampled(id, 0.1)).toBe(isSessionSampled(id, 0.1));
    }
  });

  it("samples none at 0 and all at 1", () => {
    expect(isSessionSampled("any", 0)).toBe(false);
    expect(isSessionSampled("any", 1)).toBe(true);
  });
});
