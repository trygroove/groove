import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findInlineStyles,
  inlineStylesInHtml,
  inlineStylesInScript,
} from "./verify-no-inline-styles.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-no-inline-styles-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relativePath, content) {
  const full = join(dir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("inlineStylesInHtml", () => {
  it("finds a style attribute, quoted or not", () => {
    expect(
      inlineStylesInHtml(
        '<main><h1 style="color:red">Hi</h1><p style=margin:0>x</p><p>ok</p></main>',
      ),
    ).toEqual(['<h1 style="color:red">', "<p style=margin:0>"]);
  });

  it("finds a style element", () => {
    expect(inlineStylesInHtml("<head><style>p{}</style></head>")).toEqual(["<style>"]);
  });

  it("ignores attributes that only end in style, and script bodies", () => {
    expect(
      inlineStylesInHtml(
        '<div data-style="x" class="landing-hero"></div>' +
          '<link rel="stylesheet" href="/a.css">' +
          '<script type="application/ld+json">{"text":"<p style=x>"}</script>',
      ),
    ).toEqual([]);
  });
});

describe("inlineStylesInScript", () => {
  it("finds a style attribute Solid's compiler baked into a template", () => {
    // The shape that reached `main` before GRV-105: a constant entry in a
    // `style={{ … }}` object, folded into the cloned template.
    expect(
      inlineStylesInScript(
        "var FO=h(`<div class=arrangement-below-tracks style=left:200px>`),RO=h(`<li><button type=button>`);",
      ),
    ).toEqual(["<div class=arrangement-below-tracks style=left:200px>"]);
  });

  it("finds one in a quoted string and in a nested element", () => {
    expect(
      inlineStylesInScript(
        'x("<div><span style=\\"color:red\\">a</span></div>");y(\'<style>p{}</style>\')',
      ),
    ).toHaveLength(2);
  });

  it("leaves runtime-applied styles alone", () => {
    // Solid applies a dynamic `style={{ … }}` entry through `element.style`,
    // which a CSP allows; so is a property that merely names `style`.
    expect(
      inlineStylesInScript(
        "h(`<div class=track-rail>`);e.style.setProperty(`--w`,`200px`);n.style.cssText=t;get style(){return{}}",
      ),
    ).toEqual([]);
  });
});

describe("findInlineStyles", () => {
  it("passes a clean build", () => {
    write("index.html", '<html><body><div class="landing-hero"></div></body></html>');
    write("assets/app.js", "h(`<div class=a>`)");
    expect(findInlineStyles(dir)).toEqual([]);
  });

  it("fails on a planted inline style in HTML or a chunk, but not in a source map", () => {
    write("index.html", '<html><body><div style="display:none"></div></body></html>');
    write("assets/Project.js", "h(`<li class=row style=position:absolute>`)");
    write("assets/Project.js.map", '{"sourcesContent":["<li style=\\"a\\">"]}');
    expect(findInlineStyles(dir)).toEqual([
      {
        file: join("assets", "Project.js"),
        snippet: "<li class=row style=position:absolute>",
      },
      { file: "index.html", snippet: '<div style="display:none">' },
    ]);
  });
});
