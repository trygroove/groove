#!/usr/bin/env node
// PRD `OPS-01` / `9.1` / `10` Security and privacy: "no secret, provider
// credential, or privileged configuration reaches the client bundle; a check
// fails the build if one does." This scans a built Hosting output directory
// (`dist/client` by default, matching `firebase.json`'s `hosting.public`)
// for the *shape* of server-only credentials.
//
//   node scripts/verify-no-secrets-in-bundle.mjs [dir]
//
// This is deliberately NOT a check for Firebase's client config values
// (`VITE_FIREBASE_API_KEY`, the Sentry DSN once `FND-001c` lands, etc). Those
// are public-by-design -- protected by server-side security rules and
// Sentry's project scoping, not secrecy -- and shipping them to the browser
// is the intended, documented behavior (PRD 9.1, ADR 0001). What this catches
// is credentials that should only ever exist in CI: a service-account key, a
// raw `.env`-style assignment of a named server secret, or a generic
// high-signal token shape (AWS access keys, GitHub tokens).
//
// This is defense-in-depth, not the only safeguard: Vite only exposes
// `VITE_`-prefixed environment variables to `import.meta.env` by default, so
// a server-only secret reaching the bundle already requires code to go out
// of its way (e.g. a stray `define`, or importing a server-only module from
// client code). This script catches that mistake before it ships.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Extensions worth scanning as text. Compressed pre-encoded variants
 * (`.br`/`.gz`) are skipped -- their uncompressed sibling is scanned instead,
 * and treating compressed bytes as UTF-8 text would just produce noise.
 */
const SCANNABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
  ".json",
  ".txt",
  ".map",
]);

/**
 * Each pattern names a credential *shape*, not a specific product's API key
 * format that happens to also be safe to expose (see the file banner above).
 */
export const FORBIDDEN_PATTERNS = [
  {
    name: "PEM private key",
    pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  },
  {
    name: "service account JSON (private_key_id field)",
    pattern: /"private_key_id"\s*:/,
  },
  {
    name: "service account JSON (type: service_account)",
    pattern: /"type"\s*:\s*"service_account"/,
  },
  {
    name: "AWS access key ID",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "GitHub personal/app token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    // A real key is `sk-ant-api03-` and some 95 characters; tests that check
    // a key is scrubbed from text use short stand-ins, which this skips.
    name: "Anthropic API key",
    pattern: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{80,}/,
  },
  {
    name: "Linear API key",
    pattern: /\blin_api_[A-Za-z0-9]{32,}\b/,
  },
  {
    name: "Slack token",
    pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: "Google OAuth client secret",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/,
  },
  {
    // `ALLOWLIST_ALERT_SMTP_URL` is a Secret Manager secret in this shape. A
    // real password is long (a Gmail app password is 16 letters); the docs'
    // `user:pass` examples are not.
    name: "a mail server URL with a password in it",
    pattern: /\bsmtps?:\/\/[^\s:@/'"`]+:[A-Za-z0-9%._~+-]{12,}@/,
  },
  {
    // The source-map upload's key (GRV-120). Not to be confused with the
    // project key (`phc_…`), which ships to every browser by design.
    name: "PostHog personal API key",
    pattern: /\bphx_[A-Za-z0-9]{20,}\b/,
  },
  {
    name: "a raw .env-style assignment of a known server-only secret",
    pattern:
      /\b(?:FIREBASE_SERVICE_ACCOUNT|FIREBASE_DEPLOY_SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS|SENTRY_AUTH_TOKEN|ANTHROPIC_API_KEY|QA_SIGN_IN_SERVICE_ACCOUNT|LINEAR_API_KEY|POSTHOG_PERSONAL_API_KEY)\s*=/,
  },
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

/**
 * Scans every scannable file under `dir` and returns every match found.
 * Pure with respect to the filesystem read -- no process.exit, no logging --
 * so it is straightforward to unit test.
 */
export function scanForSecrets(dir) {
  const findings = [];
  for (const file of walk(dir)) {
    if (!SCANNABLE_EXTENSIONS.has(extname(file))) continue;
    const content = readFileSync(file, "utf8");
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) {
        findings.push({ file, name });
      }
    }
  }
  return findings;
}

function main() {
  const dir = process.argv[2] ?? "dist/client";
  if (!existsSync(dir)) {
    console.error(
      `verify-no-secrets-in-bundle: "${dir}" does not exist. Run \`bun run build\` first.`,
    );
    process.exit(1);
  }

  const findings = scanForSecrets(dir);
  if (findings.length > 0) {
    console.error(
      `verify-no-secrets-in-bundle: found ${findings.length} possible secret(s) in "${dir}":`,
    );
    for (const { file, name } of findings) {
      console.error(`  - ${name}: ${file}`);
    }
    console.error(
      "A secret must never reach the client bundle (PRD OPS-01 / Security and privacy). " +
        "If this is a false positive, tighten the pattern in scripts/verify-no-secrets-in-bundle.mjs rather than deleting the check.",
    );
    process.exit(1);
  }

  console.log(`verify-no-secrets-in-bundle: no forbidden patterns found in "${dir}".`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
