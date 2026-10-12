import { defineConfig, devices } from "@playwright/test";
import { chromiumLaunchOptions } from "../../playwright.chromium";

/**
 * The emulator suite's `@sanity` subset against the **built** app, served with
 * `firebase.json`'s security headers (GRV-7).
 *
 * The everyday emulator suite (`playwright.config.ts`) runs the Vite dev
 * server, which applies none of the hosting headers and could not run under
 * the Content-Security-Policy if it did (its client injects `<style>`
 * elements). This config builds the app for the emulators and serves
 * `dist/client` through `tests/e2e/support/hostingServer.mjs`, which copies
 * the headers and rewrites from `firebase.json` and adds only the emulators'
 * origins to `connect-src`. So sign-in, opening a project, playing, saving and
 * exporting (CF-021, CF-022) all run under the enforced policy, and `hosting/csp.hosting.ts`
 * checks the headers and that a violation is reported.
 *
 * Every violation any test causes is reported to the server, and the global
 * teardown fails the run if there was one: a page that works only because a
 * refused request did not matter still fails here.
 *
 * Run it with `bun run test:browser:emulator:hosting`. The build overwrites
 * `dist/client` with an emulator build; run `bun run build` again before
 * anything that reads a production one.
 */
const PORT = 3200;
const baseURL = `http://127.0.0.1:${PORT}`;

const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const storageEmulatorHost =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199";

export default defineConfig({
  testDir: ".",
  testMatch: ["**/*.spec.ts", "**/*.hosting.ts"],
  outputDir: "../../../test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never", outputFolder: "../../../playwright-report-hosting" }],
      ]
    : "list",
  expect: {
    timeout: 15_000,
  },
  globalTeardown: "./hosting/noViolations.teardown.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `bun run library:build && bun run build && node tests/e2e/support/hostingServer.mjs dist/client ${PORT}`,
    cwd: "../../..",
    port: PORT,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      VITE_DEV_BACKEND: "emulator",
      VITE_FIRESTORE_EMULATOR_HOST: firestoreEmulatorHost,
      VITE_AUTH_EMULATOR_HOST: authEmulatorHost,
      VITE_STORAGE_EMULATOR_HOST: storageEmulatorHost,
    },
  },
  projects: [
    {
      name: "chromium",
      // The per-push subset, the two export flows (export renders offline,
      // which the subset does not reach), and the header checks themselves.
      grep: /@sanity|@hosting|CF-021|CF-022/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: chromiumLaunchOptions,
      },
    },
  ],
});
