#!/usr/bin/env node
// No secret is committed (GRV-7). The companion of
// `verify-no-secrets-in-bundle.mjs`, which checks what ships to the browser:
// this checks what is in git.
//
//   node scripts/verify-no-secrets-in-repo.mjs
//
// It scans every tracked file for the same credential shapes the bundle check
// looks for (a private key, a service-account JSON, a provider token), and
// refuses a committed `.env` file, the one place a developer's real values
// live. The Firebase web config and the Sentry DSN are public by design and
// are not flagged, exactly as in the bundle check.
//
// Two shapes are left to the bundle check: a `.env`-style assignment of a
// server secret's *name*, which the docs and `.env.example` legitimately
// write with an empty or placeholder value, and the service-account field
// names, which the scripts that read a key name in code. Their values are
// still caught by the private-key pattern.
//
// The scanners' own tests plant fake secrets on purpose and are skipped.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { FORBIDDEN_PATTERNS } from "./verify-no-secrets-in-bundle.mjs";

/** Shapes that only mean a leak in a build, not in source (see the banner). */
const BUNDLE_ONLY = new Set([
  "a raw .env-style assignment of a known server-only secret",
  "service account JSON (private_key_id field)",
  "service account JSON (type: service_account)",
]);

export const REPO_PATTERNS = FORBIDDEN_PATTERNS.filter(
  ({ name }) => !BUNDLE_ONLY.has(name),
);

/** Files that plant fake secrets to test the scanners. */
const SCANNER_TESTS = new Set([
  "scripts/verify-no-secrets-in-bundle.test.mjs",
  "scripts/verify-no-secrets-in-repo.test.mjs",
]);

/**
 * Environment files that are meant to be committed. Their contents are still
 * scanned like any other file.
 */
const COMMITTED_ENV_FILES = new Set([
  // The documented template, with every value empty.
  ".env.example",
  // Cloud Functions' per-project parameters (`defineString` in
  // `functions/src/index.ts`), which Firebase reads from git by design. The
  // functions' secrets are `defineSecret`s in Secret Manager, never here.
  "functions/.env.groove-35c07",
]);

/** A committed environment file, other than the ones meant to be. */
export function isEnvFile(path) {
  return /^\.env(\..+)?$/.test(basename(path)) && !COMMITTED_ENV_FILES.has(path);
}

/** Every finding in `files`, each read through `read(path)`. */
export function scanFiles(files, read) {
  const findings = [];
  for (const file of files) {
    if (SCANNER_TESTS.has(file)) continue;
    if (isEnvFile(file)) {
      findings.push({ file, name: "a committed .env file" });
      continue;
    }
    let content;
    try {
      content = read(file);
    } catch {
      continue;
    }
    // Binary files (audio, images, fonts) carry no text secrets worth a regex.
    if (content.includes("\u0000")) continue;
    for (const { name, pattern } of REPO_PATTERNS) {
      if (pattern.test(content)) findings.push({ file, name });
    }
  }
  return findings;
}

/** The tracked files in the working tree. */
export function trackedFiles(cwd = process.cwd()) {
  return execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" })
    .split("\u0000")
    .filter(Boolean);
}

function main() {
  const findings = scanFiles(trackedFiles(), (file) => readFileSync(file, "utf8"));
  if (findings.length > 0) {
    console.error(`verify-no-secrets-in-repo: ${findings.length} possible secret(s):`);
    for (const { file, name } of findings) console.error(`  - ${name}: ${file}`);
    console.error(
      "Remove it, rotate it, and keep it in a GitHub or Secret Manager secret instead. " +
        "If this is a false positive, tighten the pattern rather than deleting the check.",
    );
    process.exit(1);
  }
  console.log("verify-no-secrets-in-repo: no secret found in the tracked files.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
