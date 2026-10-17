#!/usr/bin/env node
//
// Fails the build when the deployed client bundle carries no Firebase client
// configuration.
//
// Why this exists: `src/firebaseConfig.ts` reads `import.meta.env.VITE_FIREBASE_*`
// and falls back to `undefined` outside mock mode, so a build with those
// variables unset succeeds, passes `verify:bundle`, and deploys cleanly -- and
// then every Auth call fails in the browser with `auth/invalid-api-key`,
// rendering the app's error boundary instead of the page. That happened on
// d65077c: the deploy job reported success and shipped an app that could not
// start a session. Only the post-deploy smoke test caught it, after the broken
// build was already live.
//
// A missing build-time constant is a build defect, not a runtime one, so it
// should fail before `firebase deploy` runs rather than after. This runs in
// `predeploy` (see package.json), between `build` and `verify:bundle`.
//
// Deliberately narrow: it asserts the *presence and shape* of values Vite
// inlined into the bundle. It cannot tell a valid API key from a revoked one --
// that is the post-deploy smoke test's job, and the two are complementary.
//
// It reads *minified* output, so it must not assume how the minifier spells
// things. Vite 8's rolldown/oxc minifier writes string literals with backticks
// where esbuild wrote double quotes, and this check -- which matched only
// double quotes -- then reported all four fields "not present in the bundle"
// on a preview build whose config was complete and correct. Nothing was wrong
// with the build; the assertion was. A shape assertion over minified code is
// only as honest as the range of shapes it accepts, which is also why this
// file now has a test that feeds it both spellings.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUILD_DIR = "dist/client";

// Only the fields whose absence breaks app startup. `databaseURL` (unused, the
// project has no Realtime Database) is deliberately not required.
const REQUIRED = [
  { key: "apiKey", pattern: /^AIza[\w-]{35}$/ },
  { key: "authDomain", pattern: /\.firebaseapp\.com$/ },
  { key: "projectId", pattern: /^[a-z0-9-]+$/ },
  { key: "appId", pattern: /^\d+:\d+:web:[a-f0-9]+$/ },
];

/**
 * How far past `apiKey:` a candidate config object is taken to extend.
 *
 * The four required fields are one contiguous object literal in
 * `src/firebaseConfig.ts`, running from `apiKey` to `appId` with three fields
 * in between -- about 250 characters once minified. Requiring them to appear
 * *together* is what makes this check mean "the config object is populated"
 * rather than "these four words each appear somewhere in 1.5 MB of
 * JavaScript". Without it, `devBackend.ts`'s placeholder `authDomain` and a
 * real `apiKey` from an unrelated chunk could satisfy the check between them
 * while the object `initializeApp` actually receives is empty -- which is not
 * hypothetical: a config-less build trips exactly that placeholder.
 */
const CONFIG_WINDOW = 800;

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...collectJsFiles(path));
    else if (entry.endsWith(".js")) out.push(path);
  }
  return out;
}

/**
 * `key: <quoted value>`, in any of the three quote styles a minifier may pick.
 *
 * Returns `null` when the key is absent or unquoted -- `apiKey:void 0`, which
 * is exactly what an unset `import.meta.env.VITE_FIREBASE_API_KEY` compiles
 * to, and the case this whole check exists to catch.
 */
function quotedValue(key, text) {
  const match = text.match(new RegExp(`${key}\\s*:\\s*(["'\`])([^"'\`]*)\\1`));
  return match ? match[2] : null;
}

function evaluate(candidate) {
  const failures = [];
  for (const { key, pattern } of REQUIRED) {
    const value = quotedValue(key, candidate);
    if (value === null) {
      failures.push(
        `${key}: not present in the bundle (built as \`undefined\` -- VITE_FIREBASE_${key
          .replace(/([A-Z])/g, "_$1")
          .toUpperCase()} was unset at build time)`,
      );
    } else if (!pattern.test(value)) {
      failures.push(`${key}: present but malformed (does not match ${pattern})`);
    }
  }
  return failures;
}

/**
 * Every reason the built client in `dir` has no usable Firebase config, or an
 * empty array when it has one.
 *
 * Which chunk holds the config depends on how the bundler split the graph, so
 * every chunk is scanned. More than one window can start with `apiKey:` --
 * `import.meta.env` is itself inlined as an object literal in some chunks --
 * so each candidate is evaluated and the best-scoring one is reported, which
 * keeps the message about the real config object rather than about whichever
 * candidate happened to come first in the file walk.
 */
export function checkClientConfig(dir = BUILD_DIR) {
  const haystack = collectJsFiles(dir)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const candidates = [...haystack.matchAll(/apiKey\s*:/g)].map((m) =>
    haystack.slice(m.index, m.index + CONFIG_WINDOW),
  );

  if (candidates.length === 0) {
    return REQUIRED.map(
      ({ key }) => `${key}: no Firebase config object found in the bundle at all`,
    );
  }
  return candidates.map(evaluate).sort((a, b) => a.length - b.length)[0];
}

function main() {
  let failures;
  try {
    failures = checkClientConfig(BUILD_DIR);
  } catch {
    console.error(
      `verify-client-config: cannot read "${BUILD_DIR}". Run \`bun run build\` first.`,
    );
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error(
      `verify-client-config: the built client in "${BUILD_DIR}" has no usable Firebase configuration.\n`,
    );
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "\nThis build would deploy successfully and then fail in the browser with\n" +
        "`auth/invalid-api-key`. Set the VITE_FIREBASE_* variables on the `prod`\n" +
        'GitHub environment (see docs/testing.md "Deploy"), then rebuild.\n' +
        "Note that a job only receives an environment's variables if it declares\n" +
        "`environment: prod`.",
    );
    process.exit(1);
  }

  console.log(
    `verify-client-config: Firebase client configuration present in "${BUILD_DIR}".`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
