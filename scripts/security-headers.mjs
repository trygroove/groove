#!/usr/bin/env node
// The HTTP security headers Firebase Hosting serves on every path (GRV-7), and
// the check that keeps `firebase.json` honest about them.
//
//   node scripts/security-headers.mjs [dir]           verify (the default)
//   node scripts/security-headers.mjs --write [dir]   rewrite firebase.json
//
// The policy is written down once, here, as data: every source a directive
// allows says why. `firebase.json`'s `hosting.headers` is generated from it
// (`--write`) and checked against it (the default), so the two cannot drift.
//
// What the check proves, against a built `dist/client`:
//
// 1. `firebase.json` serves exactly the headers this module generates, on
//    every path (`/` is `index.html`, everything else `app.html`).
// 2. Every inline script the built shells execute is allowed by its SHA-256
//    hash, computed from the built HTML rather than copied by hand. The
//    JSON-LD blocks are data, not script, and need nothing.
// 3. Every third-party origin the bundle names is either allowed by the policy
//    or listed in `NOT_LOADED_HOSTS` with the reason the app never loads from
//    it (a link a person follows, a library's documentation URL). Adding an
//    origin the app talks to without allowing it fails here, before it fails
//    in a browser.
// 4. When the build's environment is present (the deploy and preview jobs),
//    the policy allows the Firebase auth domain, the project's Cloud Functions
//    and the Sentry ingest host the build was configured with, and reports
//    violations to that DSN's project.
//
// The production values are public by design: the Firebase project ID and the
// Sentry DSN both ship in the client bundle (PRD 9.1, ADR 0001), and
// `verify-no-secrets-in-bundle.mjs` deliberately does not flag them.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

/** The production Firebase project (`vars.FIREBASE_PROJECT_ID` in CI). */
export const FIREBASE_PROJECT_ID = "groove-35c07";

/** Where every Cloud Function runs (`src/shared/cloudFunctions.ts`). */
export const CLOUD_FUNCTIONS_REGION = "us-east1";

/** The production Sentry DSN (`vars.VITE_SENTRY_DSN` in CI). Public by design. */
export const SENTRY_DSN =
  "https://4d9426cc9606b12711ad479b11caa07c@o4511857702404096.ingest.us.sentry.io/4511857708433408";

/** The Sentry environment errors are reported under (`src/monitoring/sentrySink.ts`). */
const SENTRY_ENVIRONMENT = "alpha";

/**
 * The production PostHog project's ingestion host (`vars.VITE_POSTHOG_HOST` in
 * CI): the project is in the US. `configuredOrigins` checks the build's host
 * against this policy.
 */
export const POSTHOG_INGESTION_ORIGIN = "https://us.i.posthog.com";

/**
 * The host the app uses when `VITE_POSTHOG_HOST` is unset (`POSTHOG_DEFAULT_HOST`
 * in `src/analytics/posthogTransport.ts`).
 */
const POSTHOG_APP_DEFAULT_HOST = "https://eu.i.posthog.com";

/**
 * Where the PostHog SDK reads the project's remote config for an ingestion
 * host: its region's assets host (`us.i.posthog.com` reads from
 * `us-assets.i.posthog.com`). A self-hosted or proxied host serves both.
 */
export function postHogAssetsOrigin(host) {
  const origin = new URL(host).origin;
  return origin.replace(
    /^https:\/\/(us|eu)\.i\.posthog\.com$/,
    "https://$1-assets.i.posthog.com",
  );
}

/** The Reporting API group the policy's `report-to` names. */
export const REPORT_GROUP = "csp-endpoint";

/**
 * The ingest origin and the CSP report endpoint for a DSN, per Sentry's
 * "Security Policy Reporting" documentation. The report carries what the
 * browser puts in it (the page URL, the blocked URL and directive) and nothing
 * the app adds.
 */
export function sentryEndpoints(dsn) {
  const url = new URL(dsn);
  const projectId = url.pathname.replace(/^\//, "");
  const origin = `${url.protocol}//${url.host}`;
  const report = `${origin}/api/${projectId}/security/?sentry_key=${url.username}&sentry_environment=${SENTRY_ENVIRONMENT}`;
  return { origin, report };
}

const firebaseAuthDomain = `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`;
const cloudFunctionsOrigin = `https://${CLOUD_FUNCTIONS_REGION}-${FIREBASE_PROJECT_ID}.cloudfunctions.net`;
const sentry = sentryEndpoints(SENTRY_DSN);

/**
 * The Content-Security-Policy, directive by directive, every source with its
 * reason. GA4's sources are the ones Google documents for a policy
 * ("Use Google Analytics with a Content Security Policy"), wildcards included,
 * because gtag.js picks its regional hosts at run time.
 *
 * `'unsafe-inline'` and `'unsafe-eval'` appear nowhere; the test fails
 * if either does. `script-src` gains the inline scripts' hashes when the
 * policy is generated.
 */
export const CSP_DIRECTIVES = [
  [
    "default-src",
    [["'self'", "anything not named below comes from the app's own origin"]],
  ],
  [
    "script-src",
    [
      ["'self'", "the app's bundle"],
      [
        "https://apis.google.com",
        "Firebase Auth's sign-in popup loads Google's iframe API from here",
      ],
      [
        "https://*.googletagmanager.com",
        "Firebase Analytics loads gtag.js for GA4 (PRD OPS-02)",
      ],
    ],
  ],
  [
    "style-src",
    [["'self'", "the app's stylesheets; GRV-105 removed every inline style"]],
  ],
  [
    "img-src",
    [
      ["'self'", "the app's images"],
      ["data:", "small images Vite inlines into the CSS"],
      ["blob:", "images the app draws and hands back as object URLs"],
      ["https://*.googletagmanager.com", "GA4's measurement pixel"],
      ["https://*.google-analytics.com", "GA4's measurement pixel"],
      [
        "https://www.google.com/images/cleardot.gif",
        "Firestore's WebChannel loads this one image to test the connection",
      ],
    ],
  ],
  ["font-src", [["'self'", "Inter, bundled with the app"]]],
  [
    "media-src",
    [
      ["'self'", "the landing page's video"],
      ["blob:", "audio the app renders in the browser"],
    ],
  ],
  [
    "connect-src",
    [
      ["'self'", "the factory library's manifests and audio when served same-origin"],
      ["https://firestore.googleapis.com", "Firestore"],
      ["https://identitytoolkit.googleapis.com", "Firebase Auth"],
      ["https://securetoken.googleapis.com", "Firebase Auth's token refresh"],
      [
        "https://firebasestorage.googleapis.com",
        "Cloud Storage: the library and personal packs",
      ],
      [
        "https://firebaseinstallations.googleapis.com",
        "Firebase Analytics' installation ID",
      ],
      ["https://firebase.googleapis.com", "Firebase Analytics' web config"],
      [cloudFunctionsOrigin, "the callable Cloud Functions, the assistant's included"],
      ["https://*.googletagmanager.com", "GA4's tag configuration"],
      ["https://*.google-analytics.com", "GA4's collection endpoint"],
      ["https://*.analytics.google.com", "GA4's collection endpoint"],
      [sentry.origin, "Sentry: errors, sessions and replays"],
      [POSTHOG_INGESTION_ORIGIN, "PostHog: events, replays and web vitals"],
      [
        postHogAssetsOrigin(POSTHOG_INGESTION_ORIGIN),
        "PostHog: the project's remote config",
      ],
    ],
  ],
  [
    "frame-src",
    [
      [firebaseAuthDomain, "Firebase Auth's sign-in iframe and popup"],
      [
        "https://www.youtube-nocookie.com",
        "the assistant's privacy-enhanced video player",
      ],
    ],
  ],
  [
    "worker-src",
    [
      ["'self'", "the app's own workers"],
      ["blob:", "Sentry Replay's compression worker"],
    ],
  ],
  ["object-src", [["'none'", "no plugins"]]],
  ["base-uri", [["'none'", "the document never sets a <base>"]]],
  ["form-action", [["'self'", "no form posts anywhere else"]]],
  ["frame-ancestors", [["'none'", "nothing may frame the app (clickjacking)"]]],
  [
    "report-uri",
    [[sentry.report, "Sentry's CSP endpoint, for browsers without report-to"]],
  ],
  ["report-to", [[REPORT_GROUP, "Sentry's CSP endpoint, through Reporting-Endpoints"]]],
];

/**
 * Hosts the bundle names that the app never loads anything from, and why.
 * Every other https host in `dist/client` must be allowed by the policy.
 */
export const NOT_LOADED_HOSTS = {
  "trygroove.app": "the canonical URL and link previews in the landing page's metadata",
  "schema.org": "the landing page's JSON-LD vocabulary",
  "json-schema.org": "a schema identifier in Zod's JSON Schema output",
  "www.youtube.com": "watch links a person follows from a video card",
  "policies.google.com": "a link to Google's privacy policy beside the video player",
  "tally.so": "the request-an-invite form, opened as a link",
  "firebase.google.com": "documentation links in Firebase SDK error messages",
  "securetoken.google.com":
    "the issuer a Firebase ID token names, compared, never fetched",
  "github.com": "documentation links in library error messages",
  "sentry.io": "documentation links in the Sentry SDK",
  "docs.sentry.io": "documentation links in the Sentry SDK",
  "spotlightjs.com": "a documentation link in the Sentry SDK",
  "browser.sentry-cdn.com": "Sentry's lazy-loading CDN, which the app does not use",
  "eu.i.posthog.com":
    "PostHog's EU ingestion host, the transport's default and named by the SDK; the project ingests in the US",
  "posthog.com": "documentation links in the PostHog SDK",
  "app.posthog.com": "PostHog's legacy app host, named by the SDK, never contacted",
  "us.posthog.com": "PostHog's US app host, named by the SDK, never contacted",
  "o447951.ingest.sentry.io": "an example DSN in the Sentry SDK's own messages",
  "placeholder.invalid": "a reserved, unresolvable host used as a parsing base",
  "type.googleapis.com": "protocol-buffer type names in the Firestore SDK, never fetched",
  "sandbox.googleapis.com":
    "a test-environment endpoint the Firebase SDK names but production never calls",
  "storage.googleapis.com":
    "a URL form the Storage SDK parses; the app reads through firebasestorage.googleapis.com",
};

/** Hosts in a bundle that only ever appear in code that builds a URL from parts. */
const TEMPLATE_HOST = /\$\{|^[a-z]$/;

/** The policy as one header value. */
export function contentSecurityPolicy({ scriptHashes = [] } = {}) {
  return CSP_DIRECTIVES.map(([directive, sources]) => {
    const values = sources.map(([source]) => source);
    if (directive === "script-src") {
      values.splice(1, 0, ...scriptHashes.map((hash) => `'${hash}'`));
    }
    return `${directive} ${values.join(" ")}`;
  }).join("; ");
}

/** The microphone stays open to the app itself for a later recording feature. */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "bluetooth=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=(self)",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
].join(", ");

/** `firebase.json`'s `hosting.headers`: one entry for every path. */
export function hostingHeaders({ scriptHashes = [] } = {}) {
  return [
    {
      source: "**",
      headers: [
        {
          key: "Content-Security-Policy",
          value: contentSecurityPolicy({ scriptHashes }),
        },
        { key: "Reporting-Endpoints", value: `${REPORT_GROUP}="${sentry.report}"` },
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
      ],
    },
  ];
}

/** `sha256-…` of a script's text, as a CSP source expects it. */
export function scriptHash(text) {
  return `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;
}

/** Script types a browser executes. Anything else (JSON-LD) is data. */
function executes(attributes) {
  const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
  return (
    type === undefined ||
    type === "module" ||
    type === "text/javascript" ||
    type === "application/javascript"
  );
}

/** The hash of every inline script an HTML document executes, in order. */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attributes, body] = match;
    if (/\bsrc\s*=/i.test(attributes) || !executes(attributes) || body === "") continue;
    hashes.push(scriptHash(body));
  }
  return hashes;
}

/** Every distinct https host named in the built text files under `dir`. */
export function bundleHosts(dir) {
  const hosts = new Set();
  for (const file of walk(dir)) {
    if (![".js", ".mjs", ".html", ".css"].includes(extname(file))) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/https:\/\/([A-Za-z0-9${}.*-]+)/g)) {
      const host = match[1].replace(/\.$/, "").toLowerCase();
      if (TEMPLATE_HOST.test(host) || !host.includes(".")) continue;
      hosts.add(host);
    }
    // Google's API hosts are often written bare and joined to a scheme later.
    for (const match of text.matchAll(/\b([a-z0-9-]+\.googleapis\.com)\b/g)) {
      hosts.add(match[1]);
    }
  }
  return hosts;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/** The sources a directive in a CSP header value lists. */
export function directiveSources(csp, directive) {
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name === directive) return sources;
  }
  return [];
}

/** Whether a host-source (`https://x.example`, `https://*.example`) allows `host`. */
function sourceAllowsHost(source, host) {
  // A source may name one path on a host, which still loads from that host.
  const match = /^https:\/\/(\*\.)?([^/:]+)(\/\S*)?$/.exec(source);
  if (!match) return false;
  const [, wildcard, sourceHost] = match;
  return wildcard ? host.endsWith(`.${sourceHost}`) : host === sourceHost;
}

/** Whether any fetch directive in the policy allows loading from `host`. */
export function policyAllowsHost(csp, host) {
  const fetchDirectives = [
    "script-src",
    "img-src",
    "media-src",
    "connect-src",
    "frame-src",
    "font-src",
  ];
  return fetchDirectives.some((directive) =>
    directiveSources(csp, directive).some((source) => sourceAllowsHost(source, host)),
  );
}

/**
 * The origins the build's environment configured, which the policy must allow
 * on top of what the code names. Unset values (a local build, the `build` CI
 * job) are skipped: there is nothing to compare.
 */
export function configuredOrigins(env) {
  const required = [];
  if (env.VITE_FIREBASE_AUTH_DOMAIN) {
    required.push(["frame-src", `https://${env.VITE_FIREBASE_AUTH_DOMAIN}`]);
  }
  if (env.VITE_FIREBASE_PROJECT_ID) {
    required.push([
      "connect-src",
      `https://${CLOUD_FUNCTIONS_REGION}-${env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net`,
    ]);
  }
  if (env.VITE_SENTRY_DSN) {
    const endpoints = sentryEndpoints(env.VITE_SENTRY_DSN);
    required.push(["connect-src", endpoints.origin], ["report-uri", endpoints.report]);
  }
  if (env.VITE_POSTHOG_KEY) {
    const host = env.VITE_POSTHOG_HOST || POSTHOG_APP_DEFAULT_HOST;
    const origins = new Set([new URL(host).origin, postHogAssetsOrigin(host)]);
    for (const origin of origins) required.push(["connect-src", origin]);
  }
  return required;
}

/** Everything wrong with `firebase.json`'s headers for the build in `dir`. */
export function verifySecurityHeaders({ dir, firebaseJson, env = {} }) {
  const problems = [];
  const scriptHashes = shellScriptHashes(dir);
  const expected = hostingHeaders({ scriptHashes });
  const actual = firebaseJson.hosting?.headers;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(
      "firebase.json's hosting.headers differ from scripts/security-headers.mjs " +
        "for this build. Run `bun run security-headers:write` after `bun run build`.",
    );
  }
  const csp = contentSecurityPolicy({ scriptHashes });
  if (/unsafe-inline|unsafe-eval/.test(csp)) {
    problems.push("The Content-Security-Policy allows 'unsafe-inline' or 'unsafe-eval'.");
  }
  for (const host of [...bundleHosts(dir)].sort()) {
    if (policyAllowsHost(csp, host) || host in NOT_LOADED_HOSTS) continue;
    problems.push(
      `The bundle names https://${host}, which the policy does not allow. ` +
        "Allow it in CSP_DIRECTIVES, or list it in NOT_LOADED_HOSTS with the reason the app never loads from it.",
    );
  }
  for (const [directive, source] of configuredOrigins(env)) {
    if (!directiveSources(csp, directive).includes(source)) {
      problems.push(
        `The build is configured for ${source}, which ${directive} does not name. ` +
          "Update FIREBASE_PROJECT_ID, SENTRY_DSN or POSTHOG_INGESTION_ORIGIN in scripts/security-headers.mjs " +
          "to match the build's environment, then run `bun run security-headers:write`.",
      );
    }
  }
  return problems;
}

/** The hashes of the inline scripts in both built shells, without repeats. */
export function shellScriptHashes(dir) {
  const hashes = [];
  for (const shell of ["index.html", "app.html"]) {
    const path = join(dir, shell);
    if (!existsSync(path)) continue;
    for (const hash of inlineScriptHashes(readFileSync(path, "utf8"))) {
      if (!hashes.includes(hash)) hashes.push(hash);
    }
  }
  return hashes;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const dir = args.find((arg) => !arg.startsWith("--")) ?? "dist/client";
  if (!existsSync(join(dir, "index.html"))) {
    console.error(
      `security-headers: ${dir}/index.html does not exist. Run \`bun run build\` first.`,
    );
    process.exit(1);
  }
  const firebaseJsonPath = "firebase.json";
  const firebaseJson = JSON.parse(readFileSync(firebaseJsonPath, "utf8"));
  if (write) {
    firebaseJson.hosting.headers = hostingHeaders({
      scriptHashes: shellScriptHashes(dir),
    });
    writeFileSync(firebaseJsonPath, `${JSON.stringify(firebaseJson, null, 2)}\n`);
    // Back into the repository's JSON style, so a rewrite is only the headers.
    execFileSync("bunx", ["biome", "format", "--write", firebaseJsonPath], {
      stdio: "ignore",
    });
    console.log("security-headers: wrote firebase.json's hosting.headers.");
    return;
  }
  const problems = verifySecurityHeaders({ dir, firebaseJson, env: process.env });
  if (problems.length > 0) {
    console.error(`security-headers: ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("security-headers: firebase.json serves the policy this build needs.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
