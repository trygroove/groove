#!/usr/bin/env node
// Checks that the build actually statically generated the landing page, and
// that it did not leak it onto every other route (task #297).
//
//   node scripts/verify-landing-static.mjs [dir]
//
// Three claims, none of which is obvious from reading the source:
//
//  1. **`/` carries the page.** `src/Document.tsx` prerenders the marketing
//     markup and its metadata into `index.html`. A refactor that stops it
//     rendering -- a moved import, a component that throws during the shell
//     render and is swallowed by the plugin's error boundary -- produces an
//     empty but perfectly valid build, which is the failure this exists for.
//  2. **No other path carries it.** `scripts/emit-app-shell.mjs` writes an
//     `app.html` with every `data-landing="true"` node removed, and
//     `firebase.json` serves it for `**`. A landing-only tag added without the
//     attribute would ship marketing markup, a wrong canonical URL, and a
//     wrong `og:` card on every deep link.
//  3. **The landing path stays cheap.** The landing route is eager now (see
//     `src/router.tsx`), so a static import added to it lands in the entry
//     chunk. Firebase, Sentry, and Tone must stay off that graph -- the
//     landing page reaches auth through a dynamic `import()`, and monitoring
//     is scheduled after first paint (`FND-001c`).
//
// Structural assertions rather than copy ones: the page's words are expected to
// change, and a build that fails because a sentence was edited teaches people
// to ignore it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requestAccessUrl, SITE_IMAGE, SITE_ORIGIN } from "../site.config.mjs";

const dir = process.argv[2] ?? "dist/client";
const failures = [];
const fail = (message) => failures.push(message);

const read = (name) => {
  const path = join(dir, name);
  if (!existsSync(path)) {
    fail(`${name} is missing from ${dir}.`);
    return "";
  }
  return readFileSync(path, "utf8");
};

// 1. The landing page is in `/`.
const index = read("index.html");
const landingMarkers = [
  ['id="landing-headline"', "the hero headline"],
  ['class="landing-hero"', "the hero section"],
  ['class="landing-hero-video"', "the hero video"],
  ['id="inside"', "the studio section"],
  ['class="landing-faq"', "the FAQ"],
  ['class="landing-footer"', "the footer"],
];
for (const [marker, what] of landingMarkers) {
  if (!index.includes(marker)) fail(`index.html is missing ${what} (${marker}).`);
}
// The three Request an invite calls to action (#854: the alpha is invite-only,
// so asking to be let in is the front door), each a real link to the form.
const requestAccessLinks = index.split(`href="${requestAccessUrl}"`).length - 1;
if (requestAccessLinks !== 3) {
  fail(
    `index.html has ${requestAccessLinks} Request an invite links to ${requestAccessUrl}, expected 3.`,
  );
}
for (const marker of [
  "<title",
  'name="description"',
  'rel="canonical"',
  'property="og:title"',
  'property="og:image"',
  'name="twitter:card" content="summary_large_image"',
  'name="twitter:image"',
]) {
  if (!index.includes(marker)) fail(`index.html is missing ${marker}.`);
}
if (!index.includes(`content="${SITE_ORIGIN}${SITE_IMAGE.path}"`)) {
  fail(
    `index.html does not name ${SITE_ORIGIN}${SITE_IMAGE.path} as its link-preview image.`,
  );
}

// The structured data (#1135): a SoftwareApplication and the FAQPage, each
// valid JSON.
const jsonLd = [
  ...index.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  ),
].map((match) => match[1]);
const ldTypes = [];
for (const body of jsonLd) {
  try {
    ldTypes.push(JSON.parse(body)["@type"]);
  } catch {
    fail("index.html carries JSON-LD that does not parse.");
  }
}
for (const type of ["SoftwareApplication", "FAQPage"]) {
  if (!ldTypes.includes(type)) fail(`index.html has no ${type} JSON-LD.`);
}

// The assets the prerendered page points at (#1135), each shipped beside it:
// the video, its poster, the stills, and the link-preview image.
const assetPaths = new Set(
  [
    ...index.matchAll(
      /(?:src|poster|content)="(?:https?:\/\/[^/"]+)?(\/landing\/[^"]+)"/g,
    ),
  ].map((match) => match[1]),
);
for (const required of [
  "/landing/hero.webm",
  "/landing/hero-poster.jpg",
  SITE_IMAGE.path,
]) {
  if (!assetPaths.has(required)) fail(`index.html does not reference ${required}.`);
}
for (const path of assetPaths) {
  if (!existsSync(join(dir, path)))
    fail(`${path} is referenced by index.html but not built.`);
}
if (!index.includes(`href="${SITE_ORIGIN}/"`)) {
  fail(`index.html does not name ${SITE_ORIGIN} as its canonical URL.`);
}

// 2. No other path carries it.
const shell = read("app.html");
for (const marker of [
  "data-landing",
  "landing-hero",
  "landing-headline",
  "/landing/",
  "application/ld+json",
  'rel="canonical"',
  "og:title",
  "og:image",
  "twitter:card",
]) {
  if (shell.includes(marker)) fail(`app.html still contains ${marker}.`);
}
if (!/<body>\s*<\/body>/.test(shell)) {
  fail("app.html's body is not empty -- the deep-link shell renders on the client.");
}
if (!shell.includes('<script type="module"')) {
  fail("app.html has no entry script, so a deep link would render nothing at all.");
}

// The rewrite that puts each of them where it belongs.
const hosting = JSON.parse(readFileSync("firebase.json", "utf8")).hosting;
// The deep-link rewrite is a regex that skips any path containing a dot, so a
// missing `/assets/*.js` is a 404 and not the app shell (GRV-137).
const rewrites = hosting.rewrites?.map(
  (rule) => `${rule.source ?? `regex:${rule.regex}`} -> ${rule.destination}`,
);
const expected = ["/ -> /index.html", "regex:^/[^.]*$ -> /app.html"];
if (JSON.stringify(rewrites) !== JSON.stringify(expected)) {
  fail(
    `firebase.json rewrites are ${JSON.stringify(rewrites)}, expected ${JSON.stringify(expected)}.`,
  );
}

// 3. The eager graph stays free of the heavy SDKs.
const manifestPath = join(dir, ".vite/manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const eager = new Set();
  const walk = (key) => {
    if (!key || eager.has(key)) return;
    eager.add(key);
    for (const next of manifest[key]?.imports ?? []) walk(next);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) walk(key);
  for (const key of eager) {
    const file = manifest[key]?.file ?? key;
    if (
      /firebase|sentry|posthog-js|\btone\b/i.test(key) ||
      /firebase|sentry/i.test(file)
    ) {
      fail(`${file} is statically imported by the entry; it must stay dynamic.`);
    }
  }
} else {
  fail(`${manifestPath} is missing, so the eager import graph cannot be checked.`);
}

// Robots, which is what keeps the app's own routes out of a search result.
const robots = read("robots.txt");
for (const line of [
  "Disallow: /projects",
  "Disallow: /dashboard",
  "Disallow: /admin",
  "Disallow: /not-invited",
]) {
  if (!robots.includes(line)) fail(`robots.txt is missing "${line}".`);
}

if (failures.length > 0) {
  console.error("verify-landing-static — failed:");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log("verify-landing-static — / is statically generated and app.html is clean.");
