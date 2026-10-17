import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* Read from disk, as src/theme.test.ts does: jsdom draws no scroll bars, so
   what can be pinned is the declarations (GRV-115). */
const SRC = __dirname;

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

describe("scroll bars (GRV-115)", () => {
  const app = readFileSync(join(SRC, "app.css"), "utf8");

  it("styles every scroll bar thin and themed, from one global rule", () => {
    expect(app).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*8px/);
    expect(app).toMatch(
      /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--color-border-strong\)/,
    );
    expect(app).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*thin/);
    expect(app).toMatch(
      /\*\s*\{[^}]*scrollbar-color:\s*var\(--color-border-strong\) transparent/,
    );
  });

  it("drops the arrow buttons in Chromium, which ignores them beside a standard property", () => {
    // QA on production: Chrome reads `scrollbar-width`/`scrollbar-color` in
    // preference to the pseudo-elements, and its thin bar keeps its arrows.
    // So the pseudo-elements apply everywhere, and the standard properties
    // only where the pseudo-elements are not supported (Firefox).
    expect(app).toMatch(/::-webkit-scrollbar-button\s*\{[^}]*display:\s*none/);
    const guarded = app.slice(app.indexOf("@supports not selector(::-webkit-scrollbar)"));
    expect(app).toContain("@supports not selector(::-webkit-scrollbar)");
    expect(app.indexOf("::-webkit-scrollbar-button")).toBeLessThan(
      app.indexOf("@supports not selector(::-webkit-scrollbar)"),
    );
    expect(guarded).toMatch(/scrollbar-width:\s*thin/);
    expect(app.replace(guarded, "")).not.toMatch(/^\s*scrollbar-(width|color):/m);
  });

  it("leaves no stylesheet setting a standard scroll bar of its own, which would bring the arrows back", () => {
    const own = stylesheets(SRC).filter(
      (path) =>
        !path.endsWith(join(SRC, "app.css")) &&
        /scrollbar-color:|scrollbar-width:\s*(thin|auto)/.test(
          readFileSync(path, "utf8"),
        ),
    );
    expect(own).toEqual([]);
  });

  it("never forces a bar to show", () => {
    const forcing = stylesheets(SRC).filter((path) =>
      /overflow(-[xy])?:\s*scroll\b/.test(readFileSync(path, "utf8")),
    );
    expect(forcing).toEqual([]);
  });
});
