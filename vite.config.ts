import { execSync } from "node:child_process";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

// PRD `OPS-01`: every build stamps the git commit SHA into the client so the
// deployed revision is identifiable and every analytics/error event can carry
// it (`FND-001c`). CI sets `VITE_RELEASE_SHA` explicitly (the deploy job pins
// it to the exact commit it built and deployed); `GITHUB_SHA` is Actions'
// automatic fallback for any other workflow run (e.g. the always-on `build`
// job, which never sets `VITE_RELEASE_SHA` itself). A local `bun run build`
// or `bun run dev` has neither, so it falls back to the working tree's own
// HEAD, and `"unknown"` is the last resort if even `git` is unavailable --
// this must never throw and block a build.
function resolveReleaseSha(): string {
  if (process.env.VITE_RELEASE_SHA) return process.env.VITE_RELEASE_SHA;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const releaseSha = resolveReleaseSha();

// `FND-001c` (PRD `OPS-03`): "Source maps are produced for the deployed
// revision, uploaded to Sentry through an authenticated channel from the
// `FND-001b` pipeline, and never served publicly from Hosting."
//
// Three separate mechanisms, one per clause:
//
//  1. **Produced.** `build.sourcemap: "hidden"` below emits a map for every
//     chunk but omits the `//# sourceMappingURL=` comment, so nothing in the
//     shipped JavaScript advertises where a map would live.
//  2. **Uploaded authenticated.** This plugin uploads over HTTPS with
//     `SENTRY_AUTH_TOKEN`, which exists only as a CI secret (see `.env.example`).
//     It also injects debug IDs into both the chunk and its map, so Sentry
//     matches them by ID rather than by URL -- which is what makes clause 3
//     possible at all: the maps do not need to be reachable to be usable.
//  3. **Never served.** `filesToDeleteAfterUpload` removes the maps from the
//     build output once they are safely in Sentry, so `firebase deploy` has
//     nothing to publish. `firebase.json`'s `hosting.ignore` refuses to upload
//     `**/*.map` regardless, which is the guarantee that does not depend on
//     this plugin having run -- a local build, or a build with no Sentry
//     credentials, still cannot publish a map.
//
// Inactive unless all three values are present, so a local `bun run build` and
// the always-on CI `build` job neither need credentials nor contact Sentry.
function sentryBuildPlugins() {
  const authToken = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  if (!authToken || !org || !project) return [];

  return [
    sentryVitePlugin({
      authToken,
      org,
      project,
      // Registers the release under the same SHA the client stamps into every
      // analytics and error event (PRD OPS-01), which is what lets a report in
      // Sentry be tied back to the exact deployed revision.
      release: { name: releaseSha },
      sourcemaps: {
        // One tree now, not two. Start mode's client build is the whole
        // deployable: `dist/client` holds the hashed assets *and* the
        // prerendered `index.html`, so there is no separate assembled
        // Hosting directory for a map to be copied into afterwards the way
        // vinxi's `.vinxi/build` -> `.output/public` hand-off produced.
        filesToDeleteAfterUpload: ["dist/client/**/*.map"],
      },
      // No build-time telemetry to the vendor beyond the upload itself.
      telemetry: false,
    }),
  ];
}

export default defineConfig({
  plugins: [
    // `start` (`true`, or an options bag as here) with no `ssr` is the
    // plugin's **client start mode**: the
    // serving layer that replaced SolidStart (there is no `@solidjs/start`
    // release for Solid 2, and there is no longer meant to be one -- Start is
    // now a mode of this plugin). It owns the dev server, the entries and the
    // build, so this repo no longer carries `app.config.ts`, `vinxi`,
    // `src/entry-client.tsx` or `src/entry-server.tsx`.
    //
    // It reproduces exactly what `ssr: false` plus `prerender: { routes: ["/"] }`
    // did before: `vite build` emits a purely static `dist/client` whose
    // `index.html` is the shell prerendered once through the built handler,
    // deep links get that same shell by history fallback, and the client
    // `render()`s (never hydrates) into it. The app itself never renders on
    // the server, which is the PRD's client-only decision unchanged.
    //
    // Entries are generated from `src/app.tsx` -- the plugin's root-component
    // convention accepts the lowercase spelling this repo already used.
    //
    // `errorBoundary: false` because the plugin's default boundary renders its
    // message through an inline `style` attribute, which the CSP refuses
    // (GRV-105). `src/app.tsx` carries the same boundary with a class instead.
    // The prerender of `src/Document.tsx` loses its wrapper with it, so a
    // landing page that throws fails the build rather than prerendering empty.
    solid({ start: { errorBoundary: false } }),
    ...sentryBuildPlugins(),
  ],
  define: {
    "import.meta.env.VITE_RELEASE_SHA": JSON.stringify(releaseSha),
  },
  // Pre-bundle the heavy runtime dependencies at dev-server start instead of
  // discovering them one page load at a time.
  //
  // Vite does not optimize a dependency until something imports it, and each
  // discovery force-reloads the open page:
  //
  //     [vite] ✨ new dependencies optimized: firebase/app, firebase/auth, ...
  //     [vite] ✨ optimized dependencies changed. reloading
  //
  // A cold server took four such rounds to settle -- analytics, then the
  // Firebase SDK and Sentry, then the small utilities, then `tone` when the
  // first project editor mounted. In local dev that is a visible stutter; in
  // the emulator-backed E2E suite it was a real failure, because a reload
  // landing mid-test discards whatever interaction was in flight (it ate
  // `slice.spec.ts`'s "New Project" click, which then read as a broken
  // create-project flow). Declaring them here collapses all four rounds into
  // one startup cost.
  //
  // `tone` is the one that is easy to miss: nothing on the dashboard imports
  // it, so it is only discovered when a project page first mounts -- i.e.
  // always mid-session.
  //
  // This is an optimization, not a contract: a dependency added later and
  // left out of this list still works, it just reintroduces one reload for
  // that dependency. `tests/e2e/emulator/warmDevServer.setup.ts` stays as the
  // backstop for whatever is left off, and is the load-bearing list's
  // safety net rather than its equal.
  optimizeDeps: {
    include: [
      "firebase/app",
      "firebase/analytics",
      "firebase/auth",
      "firebase/firestore",
      "@sentry/browser",
      "tone",
      "nanoid",
      "zod",
      "since-time-ago",
    ],
  },
  build: {
    // "hidden": maps are emitted but not referenced from the bundle. See
    // `sentryBuildPlugins` above for why they are still usable in Sentry.
    sourcemap: "hidden",
  },
  // Port 3000, not Vite's default 5173. vinxi served on 3000, and both
  // Playwright configs, `tests/e2e/emulator/warmDevServer.setup.ts` and
  // CONTRIBUTING.md all name that port. Pinning it here keeps this migration
  // inside the framework instead of leaking into the test harness and the docs.
  server: { port: 3000 },
  preview: { port: 3000 },
  resolve: {
    alias: {
      "~": new URL("./src", import.meta.url).pathname,
    },
  },
});
