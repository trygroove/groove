#!/usr/bin/env node
// Serves a built `dist/client` the way Firebase Hosting does (GRV-7), so the
// browser suite can run the real build under the real security headers.
//
//   node tests/e2e/support/hostingServer.mjs <dir> <port>
//
// The dev server the emulator suite normally runs against applies none of
// `firebase.json`'s headers, and could not run under them anyway: Vite's dev
// client injects `<style>` elements, which a `style-src 'self'` policy
// refuses. So `tests/e2e/emulator/playwright.hosting.config.ts` builds the app
// for the emulators and serves it through this instead.
//
// What it copies from `firebase.json`: the rewrites (`/` is `index.html`,
// every other extensionless path that is not a file is `app.html`, and a
// missing file-like path such as a gone `/assets/*.js` is a 404; GRV-137) and every header in
// `hosting.headers`, verbatim. What it changes, and only for this local run:
//
// - `connect-src` also allows the Firebase emulators' origins, which are what
//   the build talks to instead of Google's, and `frame-src` the Auth
//   emulator's, whose sign-in page stands in for Google's.
// - Violation reports also go to this server's `/__csp-report`, which keeps
//   every one it receives for the suite's teardown to fail on, and `report-to`
//   is dropped (with its `Reporting-Endpoints` header) so Chromium sends them
//   through `report-uri` straight away rather than batched up to a minute
//   later through the Reporting API. The Sentry endpoint stays in `report-uri`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

/** A violation the CSP test plants on purpose, which teardown ignores. */
export const CANARY_HOST = "csp-canary.invalid";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

/** The emulators' origins, from the hosts `firebase emulators:exec` exports. */
function emulatorOrigins(env) {
  const hosts = [
    env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080",
    env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099",
    env.FIREBASE_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199",
    env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001",
  ];
  return hosts.map((host) => `http://${host}`);
}

/** `firebase.json`'s headers, adjusted for a local run against the emulators. */
export function localHeaders(firebaseJson, env = process.env) {
  const headers = {};
  for (const { key, value } of firebaseJson.hosting.headers[0].headers) {
    if (key === "Reporting-Endpoints") continue;
    if (key !== "Content-Security-Policy") {
      headers[key] = value;
      continue;
    }
    headers[key] = value
      .split("; ")
      .filter((directive) => !directive.startsWith("report-to "))
      .map((directive) => {
        if (directive.startsWith("connect-src ")) {
          return `${directive} ${emulatorOrigins(env).join(" ")}`;
        }
        // The Auth emulator's sign-in page stands in for the Google popup.
        if (directive.startsWith("frame-src ")) {
          return `${directive} ${emulatorOrigins(env)[1]}`;
        }
        if (directive.startsWith("report-uri ")) return `${directive} /__csp-report`;
        return directive;
      })
      .join("; ");
  }
  return headers;
}

function main() {
  const [dirArg = "dist/client", portArg = "3200"] = process.argv.slice(2);
  const dir = resolve(dirArg);
  const firebaseJson = JSON.parse(readFileSync("firebase.json", "utf8"));
  const headers = localHeaders(firebaseJson);
  /** Every violation report received, in arrival order. */
  const reports = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/__csp-report" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const report = JSON.parse(body)["csp-report"] ?? JSON.parse(body);
          if (!String(report["blocked-uri"] ?? "").includes(CANARY_HOST)) {
            reports.push(report);
            console.error(`[csp] violation: ${JSON.stringify(report)}`);
          }
        } catch {
          reports.push({ unparsed: body });
        }
        response.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === "/__csp-reports") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reports));
      return;
    }

    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(dir, path);
    if (url.pathname === "/") file = join(dir, "index.html");
    else if (!existsSync(file) || statSync(file).isDirectory()) {
      const deepLink = firebaseJson.hosting.rewrites.find((rule) => rule.regex);
      if (!deepLink || !new RegExp(deepLink.regex).test(url.pathname)) {
        response.writeHead(404, { ...headers, "content-type": "text/plain" });
        response.end("Not Found");
        return;
      }
      file = join(dir, deepLink.destination);
    }

    response.writeHead(200, {
      ...headers,
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(file));
  });

  server.listen(Number(portArg), "127.0.0.1", () => {
    console.log(`hosting-server: serving ${dir} on http://127.0.0.1:${portArg}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
