import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_TOKENS } from "./arrangement/canvasRenderer";

/* Read from disk rather than through Vite: the unit suite stubs CSS modules
   out, so an import — `?raw` included — hands back an empty string. */
const SRC_DIR = resolve(process.cwd(), "src");

function cssFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFilesUnder(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** Every stylesheet under `src/`, as written on disk, keyed by relative path. */
const stylesheets = Object.fromEntries(
  cssFilesUnder(SRC_DIR).map((path) => [
    relative(SRC_DIR, path).split(sep).join("/"),
    readFileSync(path, "utf8"),
  ]),
);

const themeCss = stylesheets["theme.css"] ?? "";

/**
 * Every colour the product paints is named once, in `src/theme.css`. These
 * tests are what keeps that true: a stylesheet that reintroduces a literal, a
 * token that is read but never defined, or a canvas fallback that drifts away
 * from the theme all fail here rather than quietly costing the next palette
 * change a sweep across twenty-odd files.
 */

/** `--token: value;` declarations, as written in `theme.css`. */
function themeTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of themeCss.matchAll(
    /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim,
  )) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

/** Resolve a token through however many `var(--x)` aliases it is defined by. */
function resolveToken(name: string): string {
  const tokens = themeTokens();
  let value = tokens.get(name);
  for (let hops = 0; value !== undefined && hops < 10; hops += 1) {
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    if (!alias?.[1]) return value;
    value = tokens.get(alias[1]);
  }
  return value ?? "";
}

const COLOR_LITERAL =
  /#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|(?<![-\w])(?:white|black|lightgrey|lightgray|grey|gray|red|blue|green)(?![-\w])/gi;

/** The app's stylesheets, which is every one of them but the theme itself. */
function appStylesheets(): Record<string, string> {
  const sheets: Record<string, string> = {};
  for (const [path, source] of Object.entries(stylesheets)) {
    if (path !== "theme.css") sheets[path] = source;
  }
  return sheets;
}

/**
 * The values a stylesheet declares — not its selectors or property names, so
 * `.pr-key.black` and `white-space: nowrap` are not mistaken for colours.
 */
function declaredValues(source: string): string[] {
  return [
    ...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/[a-z-]+\s*:\s*([^;{}]+)[;}]/gi),
  ].map(([, value]) => String(value));
}

/**
 * The one exception to a colourless interface (#447): the level meters' clip
 * state, green under 0 dBFS and red over it. Pinned, so a third hue has to
 * come past this line.
 */
const SIGNAL_TOKENS = ["--signal-ok", "--signal-clip"];

/**
 * The other exception (GRV-88): the shared toast's muted dark-red fill. Pinned
 * the same way, to the one stylesheet that may read it.
 */
const TOAST_TOKENS = ["--toast-alert"];

describe("the theme is the only place a colour is written down", () => {
  it("defines the accent, the neutral ramp, and the status colours", () => {
    const tokens = themeTokens();
    for (const name of [
      "--color-accent",
      "--color-background",
      "--color-text",
      "--color-danger",
      "--color-warning",
      "--color-success",
    ]) {
      expect(tokens.has(name), `${name} is missing from theme.css`).toBe(true);
    }
  });

  it("is literally monochrome — every colour is a neutral grey", () => {
    // The whole point of the palette: no hue anywhere in the interface
    // chrome. A tinted grey is as much a violation as a blue one, so this
    // asserts R === G === B rather than merely "low saturation".
    const coloured: string[] = [];
    for (const [name, value] of themeTokens()) {
      if (SIGNAL_TOKENS.includes(name) || TOAST_TOKENS.includes(name)) continue;
      const hex = /^#([0-9a-f]{6})$/i.exec(resolveToken(name));
      if (!hex?.[1]) continue;
      const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16));
      if (r !== g || g !== b) coloured.push(`${name}: ${value}`);
    }
    expect(coloured).toEqual([]);
  });

  it("keeps the meters' signal pair to the meters (#447)", () => {
    const hued = [...themeTokens().keys()].filter((name) => name.startsWith("--signal-"));
    expect(hued).toEqual(SIGNAL_TOKENS);
    const readers = Object.entries(appStylesheets())
      .filter(([, source]) => /var\(--signal-/.test(source))
      .map(([path]) => path);
    expect(readers).toEqual(["editor/mixer/LevelMeter.css"]);
  });

  it("keeps the toast's dark red to the toast (GRV-88)", () => {
    const hued = [...themeTokens().keys()].filter((name) => name.startsWith("--toast-"));
    expect(hued).toEqual(TOAST_TOKENS);
    const readers = Object.entries(appStylesheets())
      .filter(([, source]) => /var\(--toast-/.test(source))
      .map(([path]) => path);
    expect(readers).toEqual(["components/Toast.css"]);
    // Dark and muted: red leads, but every channel stays in the bottom third.
    const hex = /^#([0-9a-f]{6})$/i.exec(resolveToken("--toast-alert"));
    const [r, g, b] = [0, 2, 4].map((i) =>
      Number.parseInt(hex?.[1]?.slice(i, i + 2) ?? "", 16),
    ) as [number, number, number];
    expect(r).toBeGreaterThan(g);
    expect(g).toBe(b);
    expect(Math.max(r, g, b)).toBeLessThan(96);
  });

  it("spends mid-greys sparingly — a short ramp between black and white", () => {
    const ramp = [...themeTokens().keys()].filter((name) => name.startsWith("--mono-"));
    expect(ramp).toContain("--mono-00");
    expect(ramp).toContain("--mono-100");
    expect(resolveToken("--mono-00")).toBe("#000000");
    expect(resolveToken("--mono-100")).toBe("#ffffff");
    // Two anchors and a handful of working shades. Adding a step is a design
    // decision, so it should have to come past this line to do it.
    expect(ramp.length).toBeLessThanOrEqual(9);
  });

  it("only ever borrows black or white for a translucent tint", () => {
    // A tint composites over whatever is beneath it, so a *tinted* tint would
    // smuggle hue in through the back door.
    const offenders: string[] = [];
    for (const [name, value] of themeTokens()) {
      const rgb = /^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\//.exec(value);
      if (!rgb) continue;
      const [r, g, b] = rgb.slice(1, 4).map(Number) as [number, number, number];
      const neutral =
        (r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255);
      if (!neutral) offenders.push(`${name}: ${value}`);
    }
    expect(offenders).toEqual([]);
  });

  it("leaves no colour literal in any other stylesheet", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(appStylesheets())) {
      for (const value of declaredValues(source)) {
        for (const match of value.matchAll(COLOR_LITERAL)) {
          offenders.push(`${path}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every dropdown one look, set once in the base layer (#447)", () => {
    // A per-surface `select` rule is how the app came to have two dropdown
    // styles; `app.css` draws them all like the sample slot.
    const offenders = Object.entries(appStylesheets())
      .filter(([path]) => path !== "app.css")
      .filter(([, source]) =>
        /(^|[\s,>+~])select(?![-\w])[^{};]*\{/m.test(
          source.replace(/\/\*[\s\S]*?\*\//g, ""),
        ),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
    expect(stylesheets["app.css"]).toMatch(/^select \{/m);
  });

  it("keeps every corner square, bar the drag handles (#447)", () => {
    // The interface is flat and square; a radius creeps in one button at a
    // time. The round handle is a deliberate shape, not a rounded box.
    const allowed = new Set(["instrument/Faceplate.css 50%"]);
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(stylesheets)) {
      for (const [, value] of source.matchAll(/border-radius:\s*([^;]+);/g)) {
        const radius = value.trim();
        if (radius !== "0" && !allowed.has(`${path} ${radius}`)) {
          offenders.push(`${path}: ${radius}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves every token those stylesheets read", () => {
    // Set on an element from TSX (`StepEditor`, `FillSlider`), never in CSS.
    // `TrackRail` sets the last three from the arrangement's own `ROW_METRICS`,
    // `HEADER_WIDTH_PX` and `RULER_HEIGHT_PX`, so a track's row is the same
    // size and place in both views without either one writing the numbers
    // down twice (`UI-001`, #447). The assistant panel (#849) sets its
    // floating width, bar size and inset from `assistantPanelLayout.ts`, and
    // publishes `--assistant-clearance` on the root for the corner chrome.
    const setFromMarkup = new Set([
      "--step-count",
      // The [+ Pad] row's place and the ground it keeps free (#947).
      "--step-lane-count",
      "--step-floor",
      "--velocity",
      "--track-row-height",
      "--track-column-width",
      "--track-ruler-height",
      "--waveform-fill",
      "--assistant-floating-width",
      "--assistant-bar-width",
      "--assistant-bar-height",
      "--assistant-inset",
      "--assistant-clearance",
      // The Export dialog's readout widths and done-screen height (GRV-156),
      // set from TSX so a phone-width media query can override them.
      "--slot-width",
      "--done-height",
    ]);
    const declared = new Set(
      Object.values(stylesheets).flatMap((source) =>
        [...source.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(([, name]) => String(name)),
      ),
    );
    const unresolved = new Set<string>();
    for (const [path, source] of Object.entries(appStylesheets())) {
      for (const [, name] of source.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!name || setFromMarkup.has(name) || declared.has(name)) continue;
        unresolved.add(`${path}: ${name}`);
      }
    }
    expect([...unresolved]).toEqual([]);
  });

  it("pins the arrangement canvas fallbacks to the theme", () => {
    // A canvas cannot read a custom property, so `canvasRenderer.ts` carries a
    // literal for the no-stylesheet case. It has to equal what the theme says.
    for (const [name, [token, fallback]] of Object.entries(COLOR_TOKENS)) {
      expect(resolveToken(token), `${name} (${token})`).toBe(fallback);
    }
  });
});

/** WCAG 2.x relative luminance of a `#rrggbb` grey. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (Number(light) + 0.05) / (Number(dark) + 0.05);
}

describe("text is readable on every surface it sits on (#76)", () => {
  // WCAG 2.1 AA (1.4.3): 4.5:1 for body text. The interface's labels are
  // small, so no text alias may lean on the 3:1 large-text allowance. The
  // browser suite's axe pass (`accessibility.spec.ts`) checks what is actually
  // painted; this pins the palette those pixels come from.
  const TEXT = [
    "--color-foreground-bright",
    "--color-text",
    "--color-text-secondary",
    "--color-foreground",
    "--color-foreground-muted",
  ];
  const SURFACES = [
    "--color-background",
    "--color-background-well",
    "--color-background-secondary",
    "--color-background-tertiary",
  ];

  it.each(TEXT)("%s clears 4.5:1 on the ground, a panel and a raised card", (text) => {
    for (const surface of SURFACES) {
      const ratio = contrast(resolveToken(text), resolveToken(surface));
      expect(
        ratio,
        `${text} on ${surface}: ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("puts readable ink on a full-strength accent fill", () => {
    const ratio = contrast(
      resolveToken("--color-on-accent"),
      resolveToken("--color-accent"),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe("control marks (UI-004, #850)", () => {
  const marks = stylesheets["controls/controlMarks.css"] ?? "";
  const rule = (mark: string): string =>
    new RegExp(`\\[data-control-mark="${mark}"\\]\\s*\\{([^}]*)\\}`).exec(marks)?.[1] ??
    "";

  it("outlines a previewed control dashed and a changed one solid", () => {
    expect(rule("previewed")).toMatch(/outline:[^;]*\bdashed\b/);
    expect(rule("changed")).toMatch(/outline:[^;]*\bsolid\b/);
  });

  it("draws both from the accent: brightness, not hue", () => {
    for (const mark of ["previewed", "changed"]) {
      expect(rule(mark), mark).toMatch(/outline:[^;]*var\(--color-accent\)/);
    }
    expect(resolveToken("--color-accent")).toBe("#ffffff");
  });
});
