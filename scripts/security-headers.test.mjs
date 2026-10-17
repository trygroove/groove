import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REMOVE_WHEN_NOT_LANDING } from "../src/landingShellScript";
import {
  CSP_DIRECTIVES,
  configuredOrigins,
  contentSecurityPolicy,
  directiveSources,
  FIREBASE_PROJECT_ID,
  hostingHeaders,
  inlineScriptHashes,
  NOT_LOADED_HOSTS,
  policyAllowsHost,
  SENTRY_DSN,
  scriptHash,
  sentryEndpoints,
  verifySecurityHeaders,
} from "./security-headers.mjs";

const firebaseJson = JSON.parse(readFileSync("firebase.json", "utf8"));
const served = firebaseJson.hosting.headers;
const header = (key) => served[0].headers.find((entry) => entry.key === key)?.value;
const csp = () => header("Content-Security-Policy");

describe("firebase.json's security headers", () => {
  it("are the ones scripts/security-headers.mjs generates for the landing script", () => {
    // The build check (`verify:security-headers`) hashes the built HTML; this
    // hashes the source, so an edit to the script fails here first.
    expect(served).toEqual(
      hostingHeaders({ scriptHashes: [scriptHash(REMOVE_WHEN_NOT_LANDING)] }),
    );
  });

  it("apply to every path, `/` and the app shell alike", () => {
    expect(served).toHaveLength(1);
    expect(served[0].source).toBe("**");
    const destinations = firebaseJson.hosting.rewrites.map(
      (rewrite) => rewrite.destination,
    );
    expect(destinations).toEqual(["/index.html", "/app.html"]);
  });

  it("enforce a policy with no 'unsafe-inline' or 'unsafe-eval' anywhere", () => {
    expect(csp()).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes/);
    expect(served[0].headers.map((entry) => entry.key)).not.toContain(
      "Content-Security-Policy-Report-Only",
    );
    expect(directiveSources(csp(), "style-src")).toEqual(["'self'"]);
    expect(directiveSources(csp(), "script-src").slice(0, 2)).toEqual([
      "'self'",
      `'${scriptHash(REMOVE_WHEN_NOT_LANDING)}'`,
    ]);
    expect(directiveSources(csp(), "object-src")).toEqual(["'none'"]);
    expect(directiveSources(csp(), "frame-ancestors")).toEqual(["'none'"]);
  });

  it("report violations to Sentry's CSP endpoint for the project's DSN", () => {
    const { origin, report } = sentryEndpoints(SENTRY_DSN);
    expect(report).toMatch(
      /^https:\/\/o\d+\.ingest\.us\.sentry\.io\/api\/\d+\/security\/\?sentry_key=[0-9a-f]{32}&sentry_environment=alpha$/,
    );
    expect(directiveSources(csp(), "report-uri")).toEqual([report]);
    expect(directiveSources(csp(), "report-to")).toEqual(["csp-endpoint"]);
    expect(header("Reporting-Endpoints")).toBe(`csp-endpoint="${report}"`);
    expect(directiveSources(csp(), "connect-src")).toContain(origin);
  });

  it("send report-to reports to the same endpoint as report-uri", () => {
    // The hosting-mode browser suite (`tests/e2e/support/hostingServer.mjs`)
    // drops `report-to` and `Reporting-Endpoints` so Chromium reports at once
    // through `report-uri`, which is all that suite proves. This is the only
    // check on the Reporting API route: the group `report-to` names must be
    // declared in `Reporting-Endpoints`, at the URL `report-uri` sends to.
    const [group] = directiveSources(csp(), "report-to");
    const declared = Object.fromEntries(
      header("Reporting-Endpoints")
        .split(/,\s*/)
        .map((entry) => entry.match(/^([\w-]+)="([^"]+)"$/)?.slice(1) ?? []),
    );
    expect(Object.keys(declared)).toEqual([group]);
    expect(declared[group]).toBe(directiveSources(csp(), "report-uri")[0]);
    expect(new URL(declared[group]).protocol).toBe("https:");
  });

  it("allow the Firebase services the production project is configured for", () => {
    expect(directiveSources(csp(), "frame-src")).toContain(
      `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
    );
    for (const host of [
      "firestore.googleapis.com",
      "identitytoolkit.googleapis.com",
      "securetoken.googleapis.com",
      "firebasestorage.googleapis.com",
      `us-east1-${FIREBASE_PROJECT_ID}.cloudfunctions.net`,
      "region1.google-analytics.com",
    ]) {
      expect(policyAllowsHost(csp(), host), host).toBe(true);
    }
    expect(policyAllowsHost(csp(), "evil.example.com")).toBe(false);
  });

  it("carry the other headers", () => {
    expect(header("Strict-Transport-Security")).toMatch(/^max-age=\d{8,}/);
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("X-Frame-Options")).toBe("DENY");
    const permissions = header("Permissions-Policy").split(", ");
    expect(permissions).toContain("microphone=(self)");
    expect(permissions).toContain("camera=()");
    expect(permissions).toContain("geolocation=()");
    // Audio playback and the video player's delegated features need nothing.
    expect(permissions.some((entry) => entry.startsWith("autoplay"))).toBe(false);
    expect(permissions.some((entry) => entry.startsWith("fullscreen"))).toBe(false);
  });

  it("say why every source is allowed", () => {
    for (const [directive, sources] of CSP_DIRECTIVES) {
      for (const [source, why] of sources) {
        expect(why.length, `${directive} ${source}`).toBeGreaterThan(5);
      }
    }
    for (const [host, why] of Object.entries(NOT_LOADED_HOSTS)) {
      expect(why.length, host).toBeGreaterThan(5);
    }
  });
});

describe("inlineScriptHashes", () => {
  it("hashes the scripts a browser executes and nothing else", () => {
    const html = [
      '<script type="application/ld+json">{"@context":"https://schema.org"}</script>',
      '<script type="module" src="/assets/entry.js"></script>',
      "<script>run()</script>",
      '<script type="module">go()</script>',
    ].join("");
    expect(inlineScriptHashes(html)).toEqual([scriptHash("run()"), scriptHash("go()")]);
  });

  it("matches the browser's hash: base64 SHA-256 of the exact text", () => {
    // From the CSP spec's own example.
    expect(scriptHash("alert('Hello, world.');")).toBe(
      "sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng=",
    );
  });
});

describe("verifySecurityHeaders against a build", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "security-headers-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(relativePath, content) {
    const full = join(dir, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  function build({ script = REMOVE_WHEN_NOT_LANDING, code = "" } = {}) {
    write("index.html", `<html><body><script>${script}</script></body></html>`);
    write("app.html", "<html><body></body></html>");
    write("assets/entry.js", code);
  }

  it("passes a build the committed headers were generated for", () => {
    build({ code: 'fetch("https://firestore.googleapis.com/v1");' });
    expect(verifySecurityHeaders({ dir, firebaseJson })).toEqual([]);
  });

  it("fails when the landing script changed but the hash did not", () => {
    build({ script: `${REMOVE_WHEN_NOT_LANDING};` });
    expect(verifySecurityHeaders({ dir, firebaseJson }).join("\n")).toMatch(
      /security-headers:write/,
    );
  });

  it("fails when the bundle names a third-party origin the policy does not allow", () => {
    build({ code: 'fetch("https://api.newvendor.example/collect");' });
    expect(verifySecurityHeaders({ dir, firebaseJson }).join("\n")).toMatch(
      /https:\/\/api\.newvendor\.example/,
    );
  });

  it("allows an origin the bundle names only as a link it never loads", () => {
    build({ code: 'const help = "https://docs.sentry.io/platforms";' });
    expect(verifySecurityHeaders({ dir, firebaseJson })).toEqual([]);
  });

  it("fails when the build was configured for another project or DSN", () => {
    build();
    const env = {
      VITE_FIREBASE_AUTH_DOMAIN: "other-project.firebaseapp.com",
      VITE_FIREBASE_PROJECT_ID: "other-project",
      VITE_SENTRY_DSN:
        "https://0123456789abcdef0123456789abcdef@o1.ingest.de.sentry.io/2",
    };
    const problems = verifySecurityHeaders({ dir, firebaseJson, env }).join("\n");
    expect(problems).toMatch(/other-project\.firebaseapp\.com/);
    expect(problems).toMatch(/us-east1-other-project\.cloudfunctions\.net/);
    expect(problems).toMatch(/o1\.ingest\.de\.sentry\.io/);
  });

  it("passes the production configuration", () => {
    build();
    const env = {
      VITE_FIREBASE_AUTH_DOMAIN: `${FIREBASE_PROJECT_ID}.firebaseapp.com`,
      VITE_FIREBASE_PROJECT_ID: FIREBASE_PROJECT_ID,
      VITE_SENTRY_DSN: SENTRY_DSN,
    };
    expect(configuredOrigins(env)).toHaveLength(4);
    expect(verifySecurityHeaders({ dir, firebaseJson, env })).toEqual([]);
  });

  it("requires the PostHog host a build configures to be allowed", () => {
    expect(configuredOrigins({ VITE_POSTHOG_KEY: "phc_x" })).toEqual([
      ["connect-src", "https://eu.i.posthog.com"],
    ]);
    const us = configuredOrigins({
      VITE_POSTHOG_KEY: "phc_x",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    });
    expect(policyAllowsHost(contentSecurityPolicy(), "us.i.posthog.com")).toBe(false);
    expect(us).toEqual([["connect-src", "https://us.i.posthog.com"]]);
  });

  it("never generates a policy with an unsafe source", () => {
    expect(contentSecurityPolicy({ scriptHashes: ["sha256-x"] })).not.toMatch(/unsafe/);
  });
});
