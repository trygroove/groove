#!/usr/bin/env node
// Checks that the build ships no inline style the browser has to *parse*
// (GRV-105), so the Content Security Policy can leave `'unsafe-inline'` out of
// `style-src` (GRV-7).
//
//   node scripts/verify-no-inline-styles.mjs [dir]
//
// CSP draws its line between styles the browser parses and styles a script
// sets through the CSSOM:
//
//  - **Blocked:** a `style="…"` attribute in served HTML, a `<style>` element,
//    and a `style` attribute inside a template string Solid's compiler bakes
//    into a chunk. Solid clones those templates by parsing them as HTML, so a
//    static entry in a `style={{ … }}` object (`position: "absolute"`, or a
//    `${CONST}px` it can fold at compile time) ends up as an attribute in the
//    template and is refused at runtime, with no visible sign but a layout
//    that has quietly lost a rule.
//  - **Allowed:** the dynamic entries of a `style={{ … }}` object, which Solid
//    applies through `element.style`, and `element.style.setProperty`.
//
// So the fix for a failure here is a class in a stylesheet, or a custom
// property set through `element.style.setProperty` where the value has to come
// from TypeScript. See `src/arrangement/ArrangementView.tsx` for both.
//
// What is scanned: every `.html` file in `dir`, and every `.js` chunk's string
// literals that start with a tag (`<div …`), which is the shape Solid's
// templates take. Source maps are skipped: they carry the source, not what
// runs. A runtime `setAttribute("style", …)` is out of reach of a static scan
// and is left to the strict-CSP browser pass (GRV-7).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** A `style` attribute on an opening tag, quoted or not. */
const STYLE_ATTRIBUTE = /<[a-zA-Z][\w:-]*(?:\s[^<>]*?)?\sstyle\s*=/;
/** A `<style>` element. */
const STYLE_ELEMENT = /<style[\s>]/i;

/**
 * Inline styles in an HTML document. Script bodies are blanked first, so a
 * JSON-LD answer or an inline script that mentions `style=` is not markup.
 */
export function inlineStylesInHtml(html) {
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2");
  const found = [];
  for (const tag of markup.match(/<[a-zA-Z][^<>]*>/g) ?? []) {
    if (STYLE_ATTRIBUTE.test(tag) || STYLE_ELEMENT.test(tag)) found.push(tag);
  }
  return found;
}

/**
 * Template strings in a JS chunk that carry an inline style: any string
 * literal (backtick, double or single quoted) that opens with a tag and has a
 * `style` attribute or a `<style>` element in it.
 */
export function inlineStylesInScript(source) {
  const found = [];
  const literal =
    /`(<[a-zA-Z](?:[^`\\]|\\.)*)`|"(<[a-zA-Z](?:[^"\\\n]|\\.)*)"|'(<[a-zA-Z](?:[^'\\\n]|\\.)*)'/g;
  for (const match of source.matchAll(literal)) {
    const body = match[1] ?? match[2] ?? match[3] ?? "";
    if (STYLE_ATTRIBUTE.test(body) || STYLE_ELEMENT.test(body)) found.push(body);
  }
  return found;
}

function* files(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

/** Every inline style in a build directory, as `{ file, snippet }`. */
export function findInlineStyles(dir) {
  const offenders = [];
  for (const path of files(dir)) {
    const scan = path.endsWith(".html")
      ? inlineStylesInHtml
      : path.endsWith(".js") || path.endsWith(".mjs")
        ? inlineStylesInScript
        : null;
    if (!scan) continue;
    for (const snippet of scan(readFileSync(path, "utf8"))) {
      offenders.push({ file: relative(dir, path), snippet });
    }
  }
  return offenders;
}

function main() {
  const dir = process.argv[2] ?? "dist/client";
  if (!existsSync(dir)) {
    console.error(
      `verify-no-inline-styles — ${dir} does not exist; run \`bun run build\` first.`,
    );
    process.exit(1);
  }
  const offenders = findInlineStyles(dir);
  if (offenders.length > 0) {
    console.error(
      "verify-no-inline-styles — failed: these inline styles would be refused by a CSP",
    );
    console.error(
      "without 'unsafe-inline' in style-src. Move each into a stylesheet class, or a",
    );
    console.error("custom property set with element.style.setProperty (GRV-105).");
    for (const { file, snippet } of offenders) {
      const short = snippet.length > 160 ? `${snippet.slice(0, 157)}...` : snippet;
      console.error(`  - ${file}: ${short}`);
    }
    process.exit(1);
  }
  console.log(
    `verify-no-inline-styles — ${dir} has no inline style attribute or element.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
