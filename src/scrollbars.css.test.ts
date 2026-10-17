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
    expect(app).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*thin/);
    expect(app).toMatch(
      /\*\s*\{[^}]*scrollbar-color:\s*var\(--color-border-strong\) transparent/,
    );
  });

  it("drops the arrow buttons where only the WebKit pseudo-elements apply", () => {
    expect(app).toMatch(/::-webkit-scrollbar-button\s*\{[^}]*display:\s*none/);
  });

  it("never forces a bar to show", () => {
    const forcing = stylesheets(SRC).filter((path) =>
      /overflow(-[xy])?:\s*scroll\b/.test(readFileSync(path, "utf8")),
    );
    expect(forcing).toEqual([]);
  });
});
