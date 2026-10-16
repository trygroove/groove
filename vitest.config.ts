import { fileURLToPath } from "node:url";
import solid from "@solidjs/vite-plugin";
import { configDefaults, defineConfig } from "vitest/config";

// `vite-plugin-solid` normally auto-injects this setup file by checking
// `require.resolve("@testing-library/jest-dom/vitest")` and, if resolvable,
// handing Vite the *bare specifier* to resolve again later. Resolving that
// bare specifier a second time, inside a nested git worktree (this repo's own
// agent workflow runs each task in one under `.claude/worktrees/`), can walk
// up past the worktree's own `node_modules` and land on the outer checkout's
// copy instead — which Vite then refuses to load as outside its project root,
// failing every single test file before it reaches a single assertion.
// Resolving it once, here, to an absolute path removes the second lookup
// entirely, so the correct local package is used regardless of nesting.
//
// Note this resolves to the package's **ESM** entry. `import.meta.resolve`
// honours the `import` condition; a `createRequire(...).resolve()` here would
// honour `require` and hand back `dist/vitest.js`, the CJS build, which
// `require()`s vitest and dies with "Vitest cannot be imported in a CommonJS
// module" on every file.
const jestDomSetupPath = fileURLToPath(
  import.meta.resolve("@testing-library/jest-dom/vitest"),
);

/**
 * Where a run's machine-readable report lands.
 *
 * Resolved from this file rather than left relative, because Vitest resolves a
 * relative `outputFile` against the *project root*, which differs per project
 * here — a relative path would scatter one run's report across several
 * directories. `vitest-report/` sits alongside Playwright's `playwright-report/`
 * and is deliberately **not** under `test-results/`: Playwright empties that
 * directory when it starts, which would delete a Vitest report captured
 * moments earlier.
 */
const jsonReport = (name: string) =>
  fileURLToPath(new URL(`vitest-report/${name}.json`, import.meta.url));

/** Shared by every project: never collect from a nested worktree checkout. */
const exclude = [...configDefaults.exclude, "tests/**", ".claude/**"];

/**
 * One application project: Solid + jsdom, over a slice of `src/`.
 *
 * Deliberately the same shape as the single un-split config, so each project
 * inherits exactly the behaviour the suite already passed under.
 *
 * **Do not set `test.environment` here.** `vite-plugin-solid` applies `jsdom`
 * itself, but only when the user has not (`if (!userTest.environment)` in the
 * plugin). Setting it explicitly — even to `"jsdom"` — takes that branch away
 * and, with it, the `test.server.deps` inlining of `solid-js` the plugin
 * applies alongside.
 */
/**
 * Deployment configuration the unit suite must never inherit.
 *
 * `src/library/manifest.ts`, `src/devBackend.ts`, and `src/release.ts` each
 * resolve one of these into a **module-level const**, so the value is frozen at
 * import time — before any `vi.stubEnv` in a test body can run. A developer
 * with a populated `.env` therefore ran a different suite than CI, which sets
 * none of them: `VITE_FIREBASE_STORAGE_BUCKET` switched `libraryUrl` to its
 * percent-encoded Cloud Storage form, `VITE_DEV_BACKEND` moved
 * `firebaseConfig` onto emulator placeholders, and `VITE_RELEASE_SHA` replaced
 * the `"unknown"` sentinel. That is a suite whose result depends on deployment
 * state, and it is how a non-terminating loop in `search.test.ts` sat
 * undetected behind fixtures that silently resolved to zero assets.
 *
 * Pinning them empty here makes a local run reproduce CI exactly. It is not a
 * substitute for covering the other branch: the configured-bucket form is
 * asserted directly by passing the value in — `libraryUrl(key, BUCKET)` in
 * `src/library/manifest.test.ts` — which is how these should be tested, rather
 * than by reading whatever the ambient environment happens to hold.
 */
const hermeticEnv = {
  VITE_FIREBASE_STORAGE_BUCKET: "",
  VITE_DEV_BACKEND: "",
  VITE_RELEASE_SHA: "",
};

const appProject = (name: string, include: string[]) => ({
  plugins: [solid()],
  resolve: { conditions: ["development", "browser"] },
  test: {
    name,
    setupFiles: [jestDomSetupPath],
    exclude,
    include,
    env: hermeticEnv,
  },
});

/**
 * The unit and component suite, split into named projects along the
 * architecture's own layers (see `docs/architecture.html`).
 *
 * This is a *filtering* device, not a coverage boundary: the projects below
 * partition exactly the files one config collected before, so `bun run
 * test:all` is the same suite it always was. What the split buys is running
 * one layer (`--project=audio`) and reading a failure or a slowdown as
 * belonging to a layer rather than to "the tests".
 *
 * `library-pipeline` is the one project that is *not* application code — it
 * covers the sample-library build tooling under `scripts/`, which an engineer
 * runs by hand and which changes infrequently. It is most of the suite's wall
 * clock, so `bun run test` leaves it out and `bun run test:library` runs it.
 * CI runs `bun run test:all`, which includes it, so nothing merges without it
 * having run — see `.github/workflows/ci.yml`.
 *
 * Adding a new `src/` directory means adding it to one of these projects. A
 * file matched by no project is silently never run, and a file matched by two
 * runs twice — `bun run verify:test-projects` fails on either.
 *
 * **Requires Vitest 4.** This is the `test.projects` API. The `defineWorkspace`
 * file it replaced could not run `vite-plugin-solid` correctly: under a
 * workspace project the plugin's `configEnvironment` hook never received the
 * client conditions, `solid-js/web` resolved to `dist/server.js`, and every
 * component test died on "Client-only API called on the server side". The same
 * config file passed when run with `--config` and failed as a project, which
 * is what identified it as a workspace bug rather than a configuration error.
 *
 * The other two suites are separate again and share nothing with this file:
 * the Firebase Emulator suite is `tests/emulator/vitest.config.ts`, and the
 * Playwright browser suites are under `tests/e2e/`. See `docs/testing.md`.
 */
export default defineConfig({
  test: {
    // The terminal reporter a human reads, plus a machine-readable transcript
    // of the same run. The JSON report is what CI uploads as an artifact
    // (`.github/workflows/ci.yml`), so a failure can be inspected — which test,
    // which file, which assertion, how long it took — without re-reading a
    // wall of log output or re-running the suite locally to reproduce it.
    //
    // `reporters` and `outputFile` are root-only options in Vitest: a project
    // cannot set its own, so this one file covers whichever projects a run
    // selects. That means `bun run test`, `bun run test:all` and `bun run
    // test:library` each overwrite `unit.json` with *their* run — the report
    // describes the last run, not a merged history.
    reporters: ["default", ["json", { outputFile: jsonReport("unit") }]],
    projects: [
      // The pure contract layers: no Firebase, Tone, or Solid imports.
      appProject("domain", [
        "src/domain/**/*.test.{ts,tsx}",
        "src/commands/**/*.test.{ts,tsx}",
        "src/projection/**/*.test.{ts,tsx}",
        "src/selection/**/*.test.{ts,tsx}",
      ]),
      // The only Tone-touching code, and so the project that needs a real
      // audio output device — see CLAUDE.md, "`bun run test` needs an audio
      // output device". Isolating it makes that dependency legible instead of
      // a property of the whole suite.
      //
      // `fileParallelism: false` is load-bearing, not tidiness. Twenty files
      // here render through `Tone.Offline`, which swaps Tone's *global*
      // context, and the backend underneath is `node-web-audio-api` — a native
      // addon, so its state is shared per **process**, not per worker thread.
      // Vitest's module isolation does not reach it. Two renders overlapping
      // in that native layer intermittently hand one of them back silence,
      // which surfaces as an assertion about audio that is suddenly ~1e-28.
      //
      // Measured rather than guessed, because "flake" is not a diagnosis:
      // with parallelism the project fails ~3 runs in 22 locally and failed
      // both of two consecutive CI runs; with it off, 16 for 16 locally. It
      // reproduces identically on `main` with Solid 1.9.9 and Vite 6 (1 in 8),
      // so it predates the Solid 2 migration and is not caused by it.
      //
      // The cost is ~11s on this project (12s → 23s). That is the right trade
      // against a suite that is red one run in seven for reasons unrelated to
      // the change under test — and it is the honest fix, since every test
      // still runs. Skipping, quarantining or retrying the affected test would
      // hide a real property of the audio backend.
      {
        ...appProject("audio", ["src/audio/**/*.test.{ts,tsx}"]),
        test: {
          ...appProject("audio", ["src/audio/**/*.test.{ts,tsx}"]).test,
          fileParallelism: false,
        },
      },
      // Components and the view models behind them.
      appProject("ui", [
        "src/editor/**/*.test.{ts,tsx}",
        "src/components/**/*.test.{ts,tsx}",
        "src/instrument/**/*.test.{ts,tsx}",
        "src/arrangement/**/*.test.{ts,tsx}",
        "src/controls/**/*.test.{ts,tsx}",
        "src/routes/**/*.test.{ts,tsx}",
        "src/onboarding/**/*.test.{ts,tsx}",
        "src/memory/**/*.test.{ts,tsx}",
      ]),
      // The boundaries that talk to something outside the app: the
      // repository, the sample-library manifest, auth, and exported files.
      appProject("data", [
        "src/persistence/**/*.test.{ts,tsx}",
        "src/library/**/*.test.{ts,tsx}",
        "src/auth/**/*.test.{ts,tsx}",
        "src/export/**/*.test.{ts,tsx}",
        "src/userData/**/*.test.{ts,tsx}",
        "src/userLibrary/**/*.test.{ts,tsx}",
        "src/access/**/*.test.{ts,tsx}",
        // The access scripts' pure logic (the QA account pool), kept out of
        // `src/` so no internal address reaches the bundle (GRV-113).
        "scripts/access/**/*.test.ts",
        "src/assistant/**/*.test.{ts,tsx}",
      ]),
      // The cross-cutting rail, plus the handful of root-level
      // `src/*.test.ts` files (telemetry, release, devBackend, firebaseConfig).
      appProject("platform", [
        "src/analytics/**/*.test.{ts,tsx}",
        "src/browser/**/*.test.{ts,tsx}",
        "src/monitoring/**/*.test.{ts,tsx}",
        "src/shortcuts/**/*.test.{ts,tsx}",
        "src/shared/**/*.test.{ts,tsx}",
        "src/testing/**/*.test.{ts,tsx}",
        "src/*.test.{ts,tsx}",
      ]),
      // The Cloud Functions' own glue (`functions/src`): the provider adapter
      // over the real SDK and the callable handler. Node, not jsdom, because
      // that is where they run, and the SDK refuses to start in a browser.
      {
        test: {
          name: "functions",
          environment: "node",
          exclude,
          include: ["functions/src/**/*.test.ts"],
          env: hermeticEnv,
        },
      },
      // Build tooling, not the app: the sample-library pipeline. Node only —
      // it never renders a component — and by far the slowest project.
      {
        test: {
          name: "library-pipeline",
          environment: "node",
          exclude,
          include: ["scripts/**/*.test.mjs"],
          env: hermeticEnv,
        },
      },
    ],
  },
});
