# Test and development foundation

| Field | Value |
| --- | --- |
| Status | Implemented (`FND-001`) |
| Scope | Shared tooling all later agents use: dependencies, test suites, CI, and test helpers |

Related documents: [Product principles](./prd.md) ([10 Non-functional requirements](./prd.md#10-non-functional-requirements)), [core flows](./core-flows.md), [`CLAUDE.md`](../CLAUDE.md#definition-of-done) for the definition of done

This document is the map of "which suite do I run, and how." It does not restate `CLAUDE.md`'s stack/style conventions, and it is not the local setup guide — [`CONTRIBUTING.md`](../CONTRIBUTING.md) covers installing prerequisites, running the app against the mock backend or a local Firebase Emulator, and the pre-PR loop.

## Suites at a glance

| Suite | Command | Runner | Environment | External services |
| --- | --- | --- | --- | --- |
| Unit + component | `bun run test` (app) · `bun run test:all` (everything) | Vitest (`vitest.config.ts`, six named projects) | jsdom, plus a Node project for the library pipeline | None — Firebase and audio are mocked/faked |
| Firebase Emulator | `bun run test:emulator` | Vitest (`tests/emulator/vitest.config.ts`), wrapped by `firebase emulators:exec` | Node | Local Firestore emulator only, started and torn down automatically |
| Browser E2E against the emulator | `bun run test:browser:emulator` | Playwright (`tests/e2e/emulator/playwright.config.ts`), wrapped by `firebase emulators:exec` | Real browsers (Chromium, Chrome, Edge, Firefox) | A local dev server against a local Firestore + Auth emulator, started and torn down automatically |
| Post-deploy smoke test | `bun run smoke:hosted` | Playwright (`tests/e2e/hosted/playwright.config.ts`) | Real browser (Chromium) | The real deployed Hosting URL (`SMOKE_URL`), real Firebase Auth/Firestore — see "Deploy" below |
| Scheduled QA sweep | `.github/workflows/qa-sweep.yml` (weekly, or run it by hand) | Agents driving Playwright (`tests/e2e/hosted/qa-sweep/playwright.config.ts`) | Real browser (Chromium) | The live app, real Firebase Auth/Firestore, each agent signed in as its own allowlisted QA account (#1055) — see "Scheduled QA sweep" below |
| Assistant musical evals | `bun run eval:assistant` (by hand only) | `scripts/eval-assistant.ts` over `src/assistant/evals` | Bun | The **live model**, with `ANTHROPIC_API_KEY` from the environment — see "Assistant musical evals" below |

### The unit suite's six projects

`vitest.config.ts` splits the unit and component suite along the layers in
[`architecture.html`](./architecture.html) using Vitest's `test.projects`.
Nothing moved on disk — the split is include globs over the existing `src/`
tree — and the projects together collect exactly the files one config collected
before. What it buys is filtering and attribution: run one layer while working
in it, and read a failure or a slowdown as belonging to a layer rather than to
"the tests".

| Project | Covers | Files |
| --- | --- | --- |
| `domain` | `src/domain`, `src/commands`, `src/projection`, `src/selection` | 38 |
| `audio` | `src/audio` | 25 |
| `ui` | `src/editor`, `src/components`, `src/instrument`, `src/arrangement`, `src/controls` | 51 |
| `data` | `src/persistence`, `src/library`, `src/auth`, `src/export`, `src/userData`, `src/userLibrary`, `src/access`, `src/assistant` | 19 |
| `platform` | `src/analytics`, `src/monitoring`, `src/shortcuts`, `src/shared`, `src/testing`, root `src/*.test.ts` | 25 |
| `functions` | `functions/src` — the Cloud Functions' glue (the assistant's provider adapter and callable handler), in Node | 2 |
| `library-pipeline` | `scripts/` — the sample-library build tooling, not the app | 16 |

```bash
bun run test                     # the application projects and functions
bun run test:all                 # every project, including library-pipeline
bun run test:library             # library-pipeline alone
bunx vitest run --project=audio  # one layer
bunx vitest --project=ui         # one layer, watch mode
```

**`bun run test` deliberately omits `library-pipeline`.** That project is build
tooling an engineer runs by hand, and it changes infrequently. The cost is real
and worth stating plainly: a local `bun run test` goes green without having
exercised `scripts/`. CI closes that gap by running `bun run test:all` (see
`.github/workflows/ci.yml`), so nothing merges unexercised, but if you are
editing the pipeline itself, run `bun run test:library` rather than trusting
`test`.

`bun run verify:test-projects` enforces the partition: every tracked test file
is owned by exactly one project. A file matched by no project never runs and
nothing else would say so; a file matched by two runs twice. Both fail the
check, and CI runs it before the suite.

**This needs Vitest 4.** The projects use the `test.projects` API. Under
Vitest 3's `defineWorkspace`, the Solid Vite plugin did not receive the client
resolve conditions, the framework's web entry resolved to its *server* build,
and every component test failed with "Client-only API called on the server
side" — the same config file passed via `--config` and failed as a project,
which is what identified it as a workspace bug rather than a configuration
error. (That was diagnosed on Solid 1, where the packages were named
`vite-plugin-solid` and `solid-js/web`; they are `@solidjs/vite-plugin` and
`@solidjs/web` now, and the Vitest 4 requirement is unchanged.)

Each suite is isolated on purpose: `bun run test` never needs a browser or an emulator running, so it stays fast enough to run on every save. `test:emulator` and `test:browser:emulator` are heavier and are meant for CI and pre-push checks. `smoke:hosted` is the odd one out — it is the only suite that touches the production project, and it only ever runs post-deploy (see "Deploy").

## Core flows

A **core flow** is one user journey that must work end to end when a feature is
finished, registered in [`docs/core-flows.md`](./core-flows.md) with a stable ID
(`CF-001`, …). Flows are not a fourth suite: they live *inside* the emulator
browser suite, in `tests/e2e/emulator/flows/`, one spec per flow named for its
ID. All of them do, and nowhere else — persistence is part of every flow's
outcome, so every flow ends by reloading the page, and the mock backend is a
fresh, empty store on every page load. What makes them different is their role,
not their runner —

- they are written **before** the implementation, in their own PR, the first the
  feature that adds the journey lands;
- they start at an entrypoint a person actually arrives at, never a deep link
  into seeded state; and
- their assertions are not weakened to fit an implementation.

`bun run verify:core-flows` (part of CI's `checks` job) enforces that every
registered flow has exactly one spec and vice versa, and reports any flow still
marked `test.fixme`. A flow spec that is skipped is green, which is why nothing
else catches it. See `CLAUDE.md`, "Core flows".

### PR screenshots

Any PR that changes UI carries screenshots of the change (see `CLAUDE.md`,
"Landing work"). `tests/e2e/support/walkthrough.ts` takes one screenshot per
`step()` call, from any spec: a core flow, an existing browser test, or a
throwaway `*.screens.spec.ts` (gitignored) written just to show the change.

```sh
bun run screenshots -- tests/e2e/emulator/x.screens.spec.ts   # any emulator-suite spec, Chromium, one worker
bun run walkthrough:capture                  # tests/e2e/emulator/flows, Chromium, one worker
bun run walkthrough:publish -- --issue GRV-123   # push the images, print the Markdown
```

Capture is off unless `CAPTURE_WALKTHROUGH=1`, which those scripts set, so the
gating runs pay nothing for it. It only produces images for specs that **pass**,
so a flow still at `test.fixme` captures nothing — that is the intended signal,
not a tooling failure.

`walkthrough:publish` exists because **images cannot be attached to a pull
request body through the GitHub API**: the media-upload endpoint behind
drag-and-drop in the web UI is not part of the REST API and `gh` has no command
for it. So the script pushes the PNGs to the `claude/walkthroughs` orphan branch
and prints `![…](https://raw.githubusercontent.com/…)` links against it. An
orphan branch, and not the feature branch, because these are review artefacts:
they have no business in `main`'s history or in a diff capped at 400 lines.
`walkthroughs/` is gitignored for the same reason.

This works because the repository is **public**. GitHub renders a Markdown image
by proxying its URL anonymously, and `raw.githubusercontent.com` refuses
anonymous reads of a private repo, so making this repository private would turn
every published walkthrough into a broken-image icon. There is no workaround from
the command line — the only host whose images render for a private repo is
GitHub's own attachment store, which nothing but the web UI can upload to.

Note what a screenshot cannot show: this is a music tool, and no still image — nor
any video, since Playwright records no audio track — is evidence that a sound
reached a speaker. A walkthrough proves the UI reached the state the flow
asserts. Audible behavior is checked by hand on the preview channel.

### The home page's pictures

The video and stills on `/` (#1135) are the real app, recorded by
`tests/e2e/emulator/landing.screens.spec.ts`, the one `*.screens.spec.ts` that
is kept. It seeds a demo song (`support/landingDemoHarness.ts`), drives the
editor against the emulator, and writes `public/landing/`. When the editor
changes enough that the home page no longer shows it, re-record and commit the
result:

```sh
bun run landing:capture
```

It skips itself in every other run, so the gating suites never rewrite
`public/`. The video is VP8 WebM, trimmed with the ffmpeg build Playwright
installs for recording, so it needs nothing beyond `bun run
test:browser:install`.

## Unit and component tests

```sh
bun run test        # run once
bun run test:watch  # watch mode
bun run test:ui     # Vitest UI
```

Config: `vitest.config.ts`. `@solidjs/vite-plugin` sets `test.environment: "jsdom"` automatically, so both plain unit tests (e.g. `src/shared/id.test.ts`) and component tests using `@solidjs/testing-library` (e.g. `src/components/Dashboard.test.tsx`) run under the same command — see those two files for the canonical shape of each.

`src/audio/InstrumentGraph.test.ts`, `src/audio/TrackAudioGraph.test.ts`, `src/audio/DeviceChain.test.ts`, and `src/audio/ProjectAudioGraph.test.ts` additionally render real audio via `node-web-audio-api` (see `src/audio/testAudioContext.ts`). Importing `tone` creates a real (non-offline) global `AudioContext` as a side effect, and `node-web-audio-api`'s `cpal` backend needs to find *some* default output device to satisfy that, even though the tests themselves only render through `Tone.Offline`. On a machine with no audio hardware (`/dev/snd` absent — every GitHub-hosted runner, most containers), that context creation throws `InvalidStateError: ... DeviceUnavailable` and the whole file fails before any test runs.

`.github/workflows/ci.yml`'s `checks` job works around this without needing real hardware or a kernel module: it installs the ALSA runtime library (`libasound2t64`) and points `~/.asoundrc` at ALSA's built-in `null` PCM as the default output device (discards every sample, touches no hardware). That gives `cpal` a device to find. Running the same suite locally on a machine with no audio device needs the same `~/.asoundrc` — [`CONTRIBUTING.md`](../CONTRIBUTING.md#a-null-alsa-device-on-machines-with-no-audio-hardware) has the exact config to copy. Machines with real audio hardware need no workaround.

These suites always dispose the instrument/graph they build once the offline render resolves. Without that, repeated back-to-back offline renders in the same process left native audio nodes bound to torn-down `OfflineAudioContext`s undisposed, which showed up as rare, wildly out-of-range sample values (filter-energy assertions occasionally comparing against values like `1e30`) once the suite could actually run past context creation. Always dispose the built instrument/graph after consuming its rendered buffer in new tests that follow this pattern.

They also **copy** rendered samples (`Float32Array.from(buffer.getChannelData(0))`, e.g. `src/audio/TrackAudioGraph.test.ts`) instead of returning the view directly. `getChannelData` returns a view backed by memory the native `AudioBuffer` owns, and the buffer becomes unreachable as soon as a render helper returns — so the backing store could be freed while a test still held the view, and an assertion would then compare against whatever had taken over that memory. This was the remaining cause of the same out-of-range symptom after the disposal fix, measured historically at about 1 run in 10 failing with wildly out-of-range values, and 0/30 once the samples were copied. **Never hold a `getChannelData` view beyond the lifetime of its `AudioBuffer`** — copy it out at the boundary, as `scripts/starter-library/acquire/audio.mjs` also does when decoding.

### `fireEvent` no longer flushes — call `flush()` before you assert

This is the single most common way a Solid 2 component test fails, and it fails
by asserting on stale state rather than by erroring, so read this before writing
one.

Two things changed together:

- **Solid 2 batches reactive updates onto the microtask queue.** After
  `setCount(1)`, `count()` still returns the old value, and no effect has run,
  until that batch drains.
- **`@solidjs/testing-library@1.0.0-beta.2` re-exports `@testing-library/dom`
  directly** (`export * from "@testing-library/dom"` in its entry point), so
  `fireEvent` is now the plain DOM helper. Under Solid 1 the library wrapped it
  in a Solid flush; it does not any more.

So a test that fires an event and then synchronously reads the DOM or the store
sees the state from *before* the event. Put `flush()` from `solid-js` between
them:

```ts
import { flush } from "solid-js";
import { fireEvent, screen } from "@solidjs/testing-library";

fireEvent.click(screen.getByRole("button", { name: "Mute" }));
flush();                       // drain the batch the click queued
expect(track().muted).toBe(true);
```

`flush()` drains the pending queue synchronously. It applies to any write made
outside the reactive system too, not just `fireEvent` — a subscription callback
firing from a fake store needs the same treatment
(`src/components/TelemetryDisclosure.test.tsx` is the worked example). Each step
of a multi-step interaction needs its own flush, because each one queues its own
batch: `src/editor/StepEditor.test.tsx`'s `stroke()`/`dragStroke()` helpers flush
after every pointer event for exactly that reason.

`flush()` is a **test** tool. It is not an escape hatch for product code — a
component that needs it is a component whose reads are in the wrong half of an
effect.

## Firebase Emulator suite

```sh
bun run test:emulator
```

`test:emulator` runs `firebase emulators:exec --only firestore,storage --project demo-solid-groove "vitest run --config tests/emulator/vitest.config.ts"`. `firebase emulators:exec` starts the Firestore and Storage emulators declared in `firebase.json`, sets `FIRESTORE_EMULATOR_HOST` and `FIREBASE_STORAGE_EMULATOR_HOST` for the child process, runs the suite, and shuts the emulator down regardless of pass/fail. A `demo-*` project ID is the Firebase-documented convention for emulator-only testing: no real GCP project, login, or credentials are needed.

The Storage emulator is there for `storage.rules` (#282, `userDataRules.emulator.test.ts`). Those rules read the per-account usage document out of Firestore to enforce the 1 GB allowance, and the Storage emulator answers that cross-service read from the project it was started with, so that one file uses `demo-solid-groove` itself rather than a per-file project. `firebase.json` also declares an `auth` emulator (port `9099`) and a `functions` emulator (port `5001`); neither is needed by this suite, so `--only` leaves them out. The usage-counting Cloud Functions are covered by `src/userData/usageLedger.test.ts`; to watch them run against the emulators, build them (`bun build functions/src/index.ts --outdir functions/lib --target node --format esm --packages external`), install `functions/`'s own dependencies (`npm --prefix functions install --no-package-lock`), and start `--only functions,firestore,storage`.

Suite location: `tests/emulator/`, isolated from `vitest.config.ts` via `tests/emulator/vitest.config.ts`'s own `include`. `tests/emulator/setup.ts` provides `createTestEnvironment()`, which reads `firestore.rules` (the real rules file, not a copy) and connects to whatever host/port the running emulator reports.

Test files run in parallel against one emulator and `clearFirestore()` wipes a whole project, so each file takes its own project ID via `emulatorProjectId("<suite>")` — without that, one file's teardown deletes another file's data mid-test.

Two suites run here:

- `firestoreRules.emulator.test.ts` proves `firestore.rules` against a real Firestore instance across the schema-v1 three-tier layout: owner and collaborator access, anonymous identities (PRJ-01), unauthenticated and cross-owner denial, ownership reassignment, backwards revisions, deletion, malformed writes, and documents that claim another project. This is the PRD 9.9 requirement that "security rules enforce ownership/collaborator access and must be tested against an emulator before sharing ships."
- `firestoreProjectRepository.emulator.test.ts` runs the shared `ProjectRepository` contract suite (`src/persistence/projectRepositoryContract.ts`) against Firestore, so the in-memory repository the fast suites use is held to the behavior of the real backend. See [`docs/persistence.md`](./persistence.md).

Requires a JDK (the emulator runs on the JVM); `.github/workflows/ci.yml` installs Temurin 21.

## Vitest JSON run reports

Both Vitest suites write a machine-readable report of every run alongside the
terminal output, via the built-in `json` reporter:

| Suite | Config | Report |
| --- | --- | --- |
| Unit + component (`bun run test`, `test:all`, `test:library`, `test:watch`) | `vitest.config.ts` | `vitest-report/unit.json` |
| Firebase Emulator (`bun run test:emulator`) | `tests/emulator/vitest.config.ts` | `vitest-report/emulator.json` |

The report lists every test file, every assertion, its status, duration and
failure messages, plus the run's totals — the same run the terminal just
described, in a form a script or another agent can read. It is written whether
the run passed or failed, which is the case it exists for: a failed run's
report names exactly what failed without anyone re-reading the log or
reproducing the run locally.

Three things about it are easy to trip over:

- **One report per run, overwritten each time.** `reporters` and `outputFile`
  are root-only options in Vitest — a project cannot set its own — so a run
  writes one file covering whichever projects it selected. `bun run test` (five
  projects), `bun run test:all` (six) and `bun run test:library` (one) all
  write `vitest-report/unit.json`, each replacing the last. The report describes
  the most recent run, not a merged history, and it carries no project name per
  file: attribute a file to a project through `vitest.config.ts`'s globs.
- **`vitest-report/`, not `test-results/`.** Playwright empties `test-results/`
  when it starts, so a report written there would vanish the moment a browser
  suite ran. The directory is gitignored and `bun run clean` removes it.
- **Watch mode rewrites it on every rerun**, so a report read while
  `bun run test:watch` is running may be a partial-selection run.

### CI keeps them as artifacts

`.github/workflows/ci.yml` uploads each report from the job that produced it,
under `if: ${{ !cancelled() }}` so a red run is captured as well as a green one
(a *cancelled* run is skipped — its report would be half-written):

| Job | Artifact | Contents |
| --- | --- | --- |
| `checks` | `vitest-report-unit` | `vitest-report/unit.json` from `bun run test:all` |
| `emulator` | `vitest-report-emulator` | `vitest-report/emulator.json` from `bun run test:emulator` |

Both are kept for 7 days, matching the Playwright report artifacts the browser
jobs upload. Download them from the run's summary page.

## Which browsers run where

The browser suite below runs up to four browsers, but not every environment
can install four browsers. The split is deliberate, and knowing which half you are
in is the difference between a useful pre-flight and a false claim of
cross-browser coverage.

| Environment | Browsers it runs | What a green run proves |
| --- | --- | --- |
| CI (`.github/workflows/ci.yml`), daily on `main` and on demand | chrome, msedge, firefox, webkit (the emulator suite) | **The cross-browser check.** Chrome, Edge and Firefox are P0 and fail the run; WebKit is `continue-on-error` signal. A failed daily run files a bug |
| A local machine | whatever `bun run test:browser:install` fetched (chromium, firefox, webkit), plus Chrome and Edge if they are installed | The same as CI, for the browsers that are there |
| A container that cannot reach `cdn.playwright.dev` (Claude Code on the web) | chromium only | A pre-flight. Says nothing about Firefox or WebKit |

The full browser matrix does **not** run per push: on a busy day, ten open
PRs queued well over a hundred browser jobs, and a sample of a day's runs found
every real catch in Chromium, with the other browsers adding only flakes. Per
push, CI runs the emulator suite's **`@sanity` subset** in Chromium
(`browser-sanity`): one pass through each major surface, about a minute of
tests. The full suites run once a day on `main`, and on demand ("Run workflow"
on the CI workflow, choosing a branch), installing only the browser each matrix
job tests. A cross-browser regression is caught within a day, as a bug on the
board (Linear); for a change you suspect is browser-specific, run CI on its branch by
hand before merging.

The sanity subset is the specs whose `test.describe` carries
`{ tag: "@sanity" }`: CF-001 (landing to a playing loop), the foundation slice
(add, play, undo, save, reload), CF-005 (a Library loop into a project), CF-006
(your own sounds into a pack), CF-008 (the five views), CF-030 (trying sounds on
a pad), CF-031 (a return bus), `authSession`, and `accessibility` (axe over
every surface, #76; see [`docs/accessibility.md`](./accessibility.md)). Run it locally with
`--grep @sanity`. Keep it small: tag a new spec only when it is the one pass
through a major surface that nothing else in the subset makes.

In a Chromium-only environment, run the pre-flight explicitly:

```sh
bun run test:browser:emulator:chromium   # tests/e2e/emulator/, chromium only
```

Use that rather than `bun run test:browser:emulator --project=chromium`, so the
command in the log names its own scope. **A green Chromium-only run is not the PRD
section 10 gating evidence** — the definition of done asks for the gating
browsers, and one of them has not run. Run CI on the branch by hand if the change
needs that evidence before it merges.

Two mechanics make this work, and neither belongs in a test:

- **`PW_CHROMIUM_PATH`** (see `tests/playwright.chromium.ts`) points the Chromium
  projects at a browser the environment already supplies. A container may
  preinstall Chromium at whatever revision *its* Playwright wanted, which is not
  the revision this repo's pin asks for, so Playwright's own lookup misses a
  binary that is sitting right there. Unset — CI, and any normal machine — the
  configs are unchanged.
- **`.claude/hooks/session-start.sh`** sets it and configures the null ALSA
  device, so an agent session starts with a working Chromium rather than
  diagnosing three environment failures that all look like code defects. It is
  synchronous because both steps are ordering-sensitive — `$CLAUDE_ENV_FILE` is
  read as the session starts, and an agent may run `bun run test` a second
  later. Both cost milliseconds. `.claude/hooks/session-start-deps.sh` runs
  `bun install` asynchronously, since that is the only slow step and nothing
  races it except a command run in the session's first seconds; the synchronous
  hook prints a notice saying to wait and retry if one does.

If you need Firefox locally to *debug* a Firefox-only CI failure, that is the
case where the blocked CDN genuinely hurts — push-and-read-the-report is a poor
substitute for instrumenting the browser, and `LOOP-003` records what guessing
instead cost. Allowlist `cdn.playwright.dev` (and its fallback
`playwright.download.prss.microsoft.com`) on the environment and run
`bun run test:browser:install`.

## Browser E2E suite

There is one browser suite, the one against the Firebase Emulator below. A second suite against the in-memory mock backend (`tests/e2e/mock/`) was retired once the emulator suite covered everything it did: its specs moved to `tests/e2e/emulator/` and the core flows. The mock backend itself stays as a development backend (`bun run dev:mock`, see `CONTRIBUTING.md`).

### Browser E2E suite against the Firebase Emulator

```sh
bun run test:browser:emulator
```

Config: `tests/e2e/emulator/playwright.config.ts`. This points the *real* Firebase SDK at a local Firestore + Auth emulator (`VITE_FIRESTORE_EMULATOR_HOST`/`VITE_AUTH_EMULATOR_HOST`, wired in `src/firebaseConfig.ts`) instead of the in-memory mock — `bun run test:browser:emulator` runs `firebase emulators:exec --only firestore,auth,storage,functions` around the Playwright run (Storage since #282, whose imports upload audio; Functions since #854, because the Auth emulator runs the blocking `beforeSignIn` function that keeps the alpha to its allowlist, built first by `bun run functions:build`), the same pattern `test:emulator` uses. This is what proves the `FND-009` slice's "save it, reload it, reproduce playback" step against a real backend: the in-memory mock repository is a fresh, empty store on every page load, so it cannot prove anything survives an actual `page.reload()`.

Suite location: `tests/e2e/emulator/`. `tests/e2e/emulator/slice.spec.ts` exercises the whole `FND-009` slice in the gating browsers (chromium, chrome, msedge, firefox — see `tests/e2e/emulator/playwright.config.ts`): sign in as a fresh invited producer (the `invitedProducer` fixture in `tests/e2e/emulator/support/test.ts`; it was anonymous start until #854 retired guest start), create a project, toggle steps on the grid, press play, undo a step, confirm the save status settles, reload the page, and confirm the reloaded project shows the same steps and the same pack dependency it saved.

`tests/e2e/emulator/dashboard.spec.ts` is `LOOP-001`'s access-control and destructive-confirmation coverage — the reason it needs the real emulator rather than the mock backend: a second `browser.newContext()` gets its own anonymous Firebase identity, so it can prove a project created by one anonymous session neither appears in another session's listing nor opens by URL (Firestore's security rules deny the read; the repository maps that `permission-denied` onto the same "not found" state an unknown ID would produce). The same file confirms a cancelled delete leaves a project in place and a confirmed one is gone after a real `page.reload()`.

### Playback is asserted in Chromium only — a known, tracked gap

`slice.spec.ts` runs in every gating browser, but its two playback assertions are guarded by `browserName === "chromium"`. Playwright reports the `chrome` and `msedge` channels as `browserName === "chromium"` too, so playback *is* asserted in branded Chrome and Edge; the gap is Firefox's. `LOOP-014` added the same guard to the keyboard-shortcut test in `tests/e2e/emulator/shortcuts.spec.ts`, for the same reason and with the same annotation — pressing `Space` dispatches identically in Firefox, but the transport button it would flip depends on the same `resume()` that never settles there. Everything else — add a note, save, revision advance, undo, reload, pack dependency — runs in Chromium *and* Firefox, so the persistence path this suite exists to prove keeps full coverage.

**Why.** In Firefox here, `useProjectAudio.play()` never reaches `setIsPlaying(true)`, so the transport button never becomes "Stop playback". What is known, from instrumenting the spec:

- a fresh `AudioContext` **constructs fine and reports `state="suspended"`**;
- the page logs **no error at all** — no `pageerror`, no `console.error`;
- so `runtime.resume()` neither resolves nor rejects. It simply never settles.

**What was tried and did not work**, recorded so nobody repeats it:

| Attempt | Outcome |
| --- | --- |
| Fix the bare `firebase` in CI (exit 127) | Real bug — the job had never run at all. Fixed, and it exposed the rest. |
| Null ALSA default output device in `browser-emulator` | No effect. Also wrong in principle: the context constructs, so no device is missing. Reverted. |
| `media.autoplay.*` Firefox user prefs | No effect. Reverted rather than left in as a workaround that does not work. |

**Measured directly during `LOOP-003`, no longer inferred.** Those three attempts were made blind, because `playwright install firefox` failed against a blocked CDN in the sandbox they were made from. That is not universally true: it succeeds on the GitHub-hosted runner, so `LOOP-003` finally instrumented the behaviour in all three browsers rather than guessing at it:

| Browser | Clicking play flips the transport button | `AudioContext.resume()` after 6s |
| --- | --- | --- |
| chromium | yes | resolved, `state="running"` |
| webkit | yes | resolved, `state="running"` |
| firefox | **no** | **still pending**, `state="suspended"` |

So the diagnosis holds exactly as written: Firefox leaves the promise pending forever. That is what `LOOP-003`'s timeout bounds. WebKit, never previously measured, plays fine and needs no guard. Anyone picking this up next should install Firefox and instrument it rather than repeating a blind fix.

Note that the `checks` job's null ALSA device is a *different* and genuinely necessary thing — `node-web-audio-api` needs it to construct a context at all under Node. Firefox in `browser-emulator` does not: its context constructs without one.

**What `LOOP-003` (#43) changed, and what it did not.** The half of this that was a real product bug is fixed: `useProjectAudio.play()` now races `runtime.resume()` against a `DEFAULT_RESUME_TIMEOUT_MS` timeout, so a never-settling unlock becomes a rejected one. Firefox now reaches the `catch`, emits `audio_start_failed` with `was_browser_blocked: true`, and reports the error, instead of leaving a promise pending forever with no telemetry at all. `AUD-07`'s "`audio_start_failed` with a browser-blocked flag when the context cannot unlock" holds in Firefox from this point on.

**The guard stays.** A bounded failure is still a failure: Firefox does not play, so `setIsPlaying(true)` is still never reached and the transport button still never becomes "Stop playback". Making the assertion unconditional would only turn one silent 30s timeout into one loud 5s one. What remains open is the *cause* — why Firefox refuses the unlock in this environment at all — which is a real-hardware, real-browser-policy question, and is `HARD-001`'s cross-browser pass, not something a headless emulator run can settle. `LOOP-003` also does not surface the failure to the user: `audio_start_failed` plus `reportError` is telemetry, so a Firefox user sees a play button that does nothing for five seconds and then still does nothing. A user-facing "your browser blocked audio" state is deliberately out of `LOOP-003`'s scope and belongs with the browser-support work in `HARD-001`. **Revisit the guard when `HARD-001` runs against real hardware; do not restore it before then.**

`LOOP-003`'s own cross-browser claim is covered by everything around playback rather than through it. `tests/e2e/emulator/transportBar.spec.ts` runs unguarded in every gating browser, Firefox included: the tempo command's round-trip and clamp, undo of a tempo edit, the loop and metronome toggles' pressed state, the fixed 4/4 display and the bar.beat playhead, and `Space`/`O` typed into the BPM input reaching the input rather than the transport. None of that needs the context to unlock, so all of it is real coverage in the gating browsers.

The playback tests annotate each run `playback-asserted` or `playback-skipped`, so the gap is visible in the report rather than only in this document.

### Why this suite warms the dev server first

Vite does not pre-bundle a dependency until something imports it, and each discovery force-reloads the open page (`[vite] ✨ optimized dependencies changed. reloading`). A reload landing mid-test discards whatever interaction was in flight. Measured on a cold server, this suite took **four** such rounds to settle — analytics, then the Firebase SDK and Sentry, then the small utilities, then `tone` when the first project editor mounted — and the reload ate `slice.spec.ts`'s `New Project` click, so the URL never left `/projects` and the test failed on `toHaveURL(/\/projects\/prj_/)`. That reads exactly like a broken create-project flow and is not one: the same suite passed in 17s against an already-warm server.

CI is always the cold case — a fresh checkout has no `node_modules/.vite`. `retries: 2` would usually have hidden this (the dev server survives between retries, so retry #1 sees a warm cache), which is worse than failing: the suite goes green and the real cause stays invisible.

Two mechanisms, and they are **not** equal partners — the first is load-bearing and the second is a backstop:

- **`vite.config.ts`'s `optimizeDeps.include`** pre-bundles those dependencies at dev-server start, collapsing all four rounds into one startup cost. This also removes the stutter from plain `bun run dev`. Measured: zero `new dependencies optimized` messages across four cold runs with it, versus a deterministic reproduction of the failure without it. It is an optimization, not a contract — a dependency added later and left off the list still works, it just reintroduces one reload for itself. `tone` is the easy one to miss, because nothing on the dashboard imports it, so it is only discovered when a project page first mounts.
- **`tests/e2e/emulator/warmDevServer.setup.ts`** walks dashboard → new project → editor once, so any remaining optimize-and-reload happens before the first assertion. It must reach the *editor*, not just the dashboard, for the `tone` reason above. It never fails the suite, and it logs precisely whether it confirmed a warm editor rather than claiming success it did not achieve.

  It runs as a Playwright **setup project**, not a `globalSetup`, and the reason is worth recording because both obvious alternatives are broken. `.github/workflows/ci.yml` installs only the matrix browser (`playwright install --with-deps ${{ matrix.browser }}`), so a `globalSetup` calling `chromium.launch()` directly has no binary in the firefox job and silently no-ops there. Reading the browser from `config.projects[0].use.defaultBrowserType` does not rescue it either: **`FullConfig.projects` is not filtered by `--project`** — verified by putting firefox first in a throwaway config and running `--project=chromium`, which still reported `projects[0] === firefox`. A setup project resolves per project, so `warmup:chromium`/`warmup:firefox` each carry their own browser, `--project=firefox` pulls in `warmup:firefox` automatically, and the warm-up's outcome appears in the report rather than only in stdout.

How much the backstop actually buys: across 11 cold runs with no effective warm-up, one failed; across 4 cold runs with it, none did. Its absence worsens the odds rather than guaranteeing a failure, which is why it stays non-fatal — and why `optimizeDeps.include` is the mechanism to keep correct.

Creating a project in the warm-up cannot disturb `slice.spec.ts`'s `No projects yet` precondition: `listProjects` scopes on `where("ownerId", "==", ownerId)`; the warm-up's browser is a fresh profile with its own identity, and each test's context signs in as its own freshly seeded invited account.

Note for anyone extending this suite: do not wait on `networkidle`. The app holds an open Firestore listener, so the network never goes idle and the wait can only time out. Wait for real elements — those locators re-resolve across a reload, which is the behaviour you want.

Five projects exist: `chromium`, `chrome`, `msedge`, `firefox`, `webkit`. Per the PRD section 10 supported-environment policy, Chrome, Edge and Firefox are P0-gating; WebKit runs in the daily pass as a `continue-on-error` signal, and Safari itself is covered by the manual pass in [`docs/runbooks/cross-browser.md`](./runbooks/cross-browser.md). `chromium` is Playwright's own build: it is not a browser anyone ships, but it is the one every environment can install, so it stays as the pre-flight and keeps gating alongside the branded two.

### The compatibility suite

`tests/e2e/emulator/compatibility.spec.ts` (#75) runs in every browser project and covers what PRD section 10 says differs between browsers, one `describe` per area:

- **Capability fallbacks**, forced by taking the API away in an init script before any app code runs (no Web Audio, no `OfflineAudioContext`, a `localStorage` that throws, a canvas that refuses a 2D context, no `download` attribute). Each asserts the editor still opens with no page error and that the notice (`src/browser/`, `src/editor/CompatibilityNotice.tsx`) says what is missing and what to do.
- **Audio unlock**: Play starts sound (Chromium family only, the known Firefox gap below), and a context whose `resume()` rejects with `NotAllowedError` is explained as blocked sound, recovering once allowed.
- **Decoding**, through the production loader on the shared context (`tests/e2e/emulator/support/decodeHarness.ts`): a factory WAV decodes to its manifest's shape, and bytes that are not audio classify as `decode_failed`.
- **Shortcuts**, **downloads** (an exported WAV arrives as one download), and **Canvas at device pixel ratio 1 and 2** (each arrangement layer's backing store is its CSS size times the ratio, and the content layer paints).

Firebase's failure states need a real backend, so `tests/e2e/emulator/firebaseFailure.spec.ts` takes the browser offline mid-edit against the emulator: the save fails visibly, offers Retry, and the offline edit is the one that persists.

### Chrome and Edge, and what "current and previous" means here

`chrome` and `msedge` are Playwright **channels** (#75): they drive the branded Google Chrome and Microsoft Edge installed on the machine, not a Playwright download, so they carry each browser's own media stack, codecs and autoplay policy — the differences PRD section 10 gates on. `bunx playwright install --with-deps chrome msedge` installs (or updates to) the current stable release of each, which is what CI's `chrome`/`msedge` jobs do on every run. It needs `sudo` on Linux and installs the browsers system-wide, which is why `bun run test:browser:install` does not do it for you; on a machine with neither installed, run the suite with `--project=chromium --project=firefox` and let CI run the branded two.

A channel resolves to whichever release is installed, and Playwright has no way to pin a previous major (`chrome-beta`/`msedge-beta` move the other way). So the automated suites prove **current** Chrome, Edge and Firefox; the **previous** major of each is covered by the manual pass in [`docs/runbooks/cross-browser.md`](./runbooks/cross-browser.md), which a release has to complete. Firefox in CI is Playwright's pinned Firefox build, current stable at the time of the pin.

`bun run test:browser:install` (`playwright install --with-deps chromium firefox webkit`) downloads browser binaries from Playwright's CDN (WebKit included, for running a spec against it by hand). That download needs outbound access to `cdn.playwright.dev`; a locked-down sandbox that blocks that host cannot install Firefox even though the config and tests are otherwise valid (verify with `bunx playwright test --list`, which does not need the binaries). That is not a reason to stop testing there — see "Which browsers run where" above for the Chromium-only pre-flight and why CI is the browser gate.

## Assistant musical evals

`bun run eval:assistant` (GRV-6) runs the assistant's musical capability cases (`src/assistant/evals/cases.ts`: a loop sketch, a variation, an arrangement, a balance and a processing change, each asked once conventionally and once at an extreme) against the **live model**, through the gateway's own turn with the production system prompt and tool schema, on seeded fixture projects. It never touches user data, Firestore or the deployed gateway's quota (its guard stores are in memory). It runs **on demand only**: never in per-push CI, never on a schedule, because every run spends real provider calls. Run it locally with `ANTHROPIC_API_KEY` set, or from the Actions tab: **Assistant evals** (`.github/workflows/eval-assistant.yml`) takes the cases, runs per case and model, reads the `ANTHROPIC_API_KEY` Actions secret, and puts `report.md` in the run summary with both report files as an artifact.

- `bun run eval:assistant` runs every case 3 times; `-- <case> [...]` runs the named ones, `--runs N` changes N, `--model claude-haiku-4-5` asks another configured model.
- It needs `ANTHROPIC_API_KEY` in the environment; without it, it says so and makes no call.
- Each run writes `report.json` (every request, reply, proposal and check, so a human can read and replay any of them) and `report.md` (the pass rate per check, then per case, then why check 1 failed in each case, then every failure) to `tmp/assistant-evals/<time>/`, or to `--out <dir>`. Check 1's failures are sorted into four kinds: `no proposal` (with why: it asked, was cut off at `max_tokens`, or called no tool), `schema`, `range` and `executor`; the console line for each run, live or `--replay`ed, ends with that reason.
- `--replay <report.json>` re-judges a saved report's proposals with the current checks and calls nothing, for iterating on a check.
- A turn that **errored** (the provider refused or failed, the transport broke, or it ran past `--timeout`, by default production's 540 s turn ceiling) is not the model's answer: no check judges it, and the report counts errored turns apart, overall and per case, with the provider's failure kind and HTTP status. A reply with no proposal is the model's answer and fails check 1. If the provider rejects the key (401/403) the run stops at once and says so; the script exits 1 then, and whenever every turn errored. The parsing and the key guard are `src/assistant/evals/cli.ts`.

The checks are deliberately few, deterministic, and never compare exact notes (`src/assistant/evals/checks.ts`, unit-tested in `bun run test` on hand-built proposals): the proposal is valid and applies through the executor; it uses ordinary commands and factory sounds only; it stays inside the case's scope; it is one undo step that restores the song exactly; every control its explanation names is one it changes; an extreme proposal is not identical to its conventional pair; and a sketch gets notes for every part it asked for (drums, bass, chords, melody, texture), each on its own clip, drums on a drum-machine track and the rest on synth tracks, so a reply that describes parts it never made fails (check 7, judged on the sketch cases only; it never compares exact notes). The report also prints descriptive numbers (note counts, pitch range, device and mixer values); nothing gates on them. A low pass rate is a finding to file, not a failure of the harness.

## Arrangement renderer measurement harness (none currently)

There is no arrangement performance suite today. `bun run bench:arrangement` and its `perf/` suite drove the `FND-008` renderer spike's unlinked `/spike/arrangement` route; both were removed with that spike once the production renderer (`src/arrangement/ArrangementView.tsx`) superseded it. See [`docs/arrangement-renderer-spike.md`](./arrangement-renderer-spike.md) for what the spike measured, why its checked-in baseline is retained as historical evidence, and what standing a harness back up against the production renderer would require. The PRD 9.3 frame budgets bind at `ARR-005` and `HARD-001`, so a harness must exist again before either is assessed.

## `check`

Use `bun run check` to check for type errors and lint the code. Check doesn't fix errors.

```sh
bun run check     # tsc --noEmit && biome check
```

## CI

`.github/workflows/ci.yml` runs on every push to `main` and `claude/**` and every pull request, and once a day on `main` (plus on demand: "Run workflow" on the CI workflow). The two browser suites run **only** in the daily and on-demand runs; every other job runs on every push:

1. **`checks`** — `bun run typecheck`, `bun run check:ci`, then a null-ALSA-device setup step (see "Unit and component tests" above) before `bun run test`, then `bun run library:validate` (see "Starter sound library" below), which validates the whole 200-asset catalogue rather than the representative sample the unit suite renders, and finally `bun run library:audit`, the release audit over the bytes that would ship (`docs/sample-library.md` section 15.11). Everything else depends on this. Uploads the run's JSON report as the `vitest-report-unit` artifact, pass or fail (see "Vitest JSON run reports" above).
2. **`browser-emulator`** (daily and on demand) — `bun run test:browser:emulator` (`FND-009`, and every core flow), matrixed over `chrome`, `msedge`, `firefox` and `webkit` (WebKit is `continue-on-error` signal; branded Chrome stands in for Playwright's Chromium, which `browser-sanity` runs), with a JDK installed for the Firestore emulator, exercising the foundation slice's add/play/undo/save/reload journey against a real (emulated) backend.
3. **`emulator`** — `bun run test:emulator`, with a JDK installed for the Firestore emulator. Uploads its JSON report as the `vitest-report-emulator` artifact, pass or fail.
4. **`build`** — `bun run build`, then `bun run verify:bundle` and `bun run verify:budget` (see "Deploy" below). Runs unconditionally, needs no Firebase project or credentials, and gates merges.
5. **`deploy`** — builds, stamps, and ships the release to Firebase Hosting; see "Deploy" below for what it does and why it usually no-ops. It waits on `checks`, `browser-sanity`, `emulator` and `build`, not on the full browser suite.
6. **`browser-sanity`** (every push and PR) — the emulator suite's `@sanity` subset in Chromium; see "Which browsers run where". It gates `deploy`.
7. **`browser-pass-report`** (daily) — when the daily browser suite fails, opens a `Bug: daily browser pass failed` issue in Linear (or comments on the open one) linking the run; and when any test only passed on a retry (`scripts/list-flaky-tests.mjs` reads each job's Playwright JSON report), opens or comments on `Bug: flaky browser tests` listing them. Both land on the board, through `.github/scripts/linear.mjs` (see [`docs/linear.md`](./linear.md)).

`.github/workflows/preview.yml` is a second, separate workflow: it publishes a PR to a Firebase Hosting preview channel, but only when that PR carries the `deploy-preview` label. See "Per-PR preview deploys" under "Deploy" below.

None of `checks`, `browser-emulator`, or `emulator` touch the production Firebase project: `browser-emulator` and `emulator` each drive their own local, disposable Firestore (+ Auth) instance. That separation is structural, not a convention to remember — neither job is ever given the production project's credentials, so there is nothing for them to write to even by mistake (PRD `OPS-01`: "Local development and every automated suite continue to run against the Firebase Emulator suite ... the test suites must not write to it").

## Deploy

| Field | Value |
| --- | --- |
| Status | Implemented (`FND-001b`) |
| Scope | Firebase Hosting deploy pipeline, `firebase.json` hosting config, the release-SHA stamp, and the hosted post-deploy smoke test |

Related: [PRD 10 Security and privacy](./prd.md#10-non-functional-requirements), [`OPS-001`](https://github.com/trygroove/groove/issues)

### The single hosted environment

The alpha has exactly one hosted environment: the **production** Firebase project. This is a deliberate PRD decision (section 16), not a gap — there is no separate staging/preview project, so every merge to `main` that reaches the `deploy` job ships straight to the environment the invited cohort uses. That is also why the deploy pipeline runs entirely from CI credentials rather than ever being something a developer machine can trigger (PRD OPS-01: "Deployment does not depend on a developer's local machine state").

The per-PR previews below do not change that. A preview channel is an extra Hosting release *inside the same production project*, not a second environment: it has its own URL and its own expiry, but its Firestore, Authentication, and Storage are production's. So PRD section 16's open question — when the alpha stops deploying only to production, and what triggers a separate staging or preview *environment* — is still open, and previews are not an answer to it.

### One documented command

```sh
bun run deploy
```

`predeploy` (`bun run build && bun run verify:bundle && bun run verify:client-config`) runs first automatically — the same pattern `predev`/`prebuild` already use for sample generation — so `bun run deploy` alone is the whole pipeline: build, scan the output for secrets, then `firebase deploy --only hosting,firestore,storage --project "$FIREBASE_PROJECT_ID"`. Firestore rules/indexes and Storage rules deploy in that same command as the application; if either fails, the whole command exits non-zero and nothing ships out of step with what shipped before it.

This needs `FIREBASE_PROJECT_ID` and Google Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account key, exactly like `library:upload`) in the environment. `.env.example` documents both, and neither belongs in a real developer's `.env` — they exist only as CI secrets/variables (see below). A local run of `bun run deploy` is possible in principle (e.g. a break-glass rollback), but is not the normal path and is never exercised by a developer in the ordinary course of work.

### CI: the `build` and `deploy` jobs

`.github/workflows/ci.yml`'s `build` job runs `bun run build`, `bun run verify:bundle`, and `bun run verify:budget` unconditionally, on every push and PR, with no credentials at all — proving the production build succeeds, ships no secret, and keeps the error-monitoring SDK off the interactive path on every change, long before a real deploy is possible.

The `deploy` job runs only when `github.ref == 'refs/heads/main'` on a `push` event, and declares `environment: prod` so the GitHub environment of that name supplies its variables and secrets.

That `environment:` declaration is load-bearing: a job that does not name an environment sees only repository-scoped values, and an environment-scoped `vars.*` lookup silently evaluates to the empty string rather than failing. For the same reason the `if:` condition deliberately does **not** gate on `vars.FIREBASE_PROJECT_ID` — GitHub evaluates a job's `if:` *before* loading its environment, so an environment-scoped variable is always empty at gate time and would skip the job on every merge. Before the `prod` environment existed the job was gated on that variable to stay inert until a real project was provisioned; the environment now serves that role, and deleting it (or removing its values) is what makes the deploy stop.

Once the project and its secrets exist, `deploy`:

1. Writes the `FIREBASE_DEPLOY_SERVICE_ACCOUNT` secret to a runner-local temp file and points `GOOGLE_APPLICATION_CREDENTIALS` at it (never committed, never logged).
2. Runs `bun run deploy` with `VITE_RELEASE_SHA` pinned to `github.sha` — the exact commit being deployed, alongside the `VITE_FIREBASE_*` client config that gets inlined into the bundle. `predeploy` builds and re-runs `verify:bundle` and `verify:client-config` against that build before `firebase deploy --only hosting,firestore,storage` ships it.
3. Marks the release deployed in Sentry (`sentry-cli releases deploys … new --env alpha`), after the deploy succeeded so a release that never shipped is never recorded as live. Skipped when the Sentry variables are unset. See "Source maps and release registration" below.
4. Installs Chromium and runs `bun run smoke:hosted` against the **public origin** — `site.config.mjs`'s `SITE_ORIGIN` (`https://trygroove.app`), resolved by the job rather than written into it, so the domain lives in one place (ADR 0008). A failing smoke test fails the job — the deploy is not considered successful until it passes (PRD OPS-01). Targeting the public origin means DNS, certificate and CDN failures fail the deploy too, not only Hosting ones; the Firebase-issued `https://$FIREBASE_PROJECT_ID.web.app` subdomain still serves the same build and is how you isolate Hosting from DNS when diagnosing one.

Required GitHub Actions configuration, all of it scoped to the **`prod` environment** (`trygroove/groove` → Settings → Environments → `prod`), named but never set by this task. Setting any of these at repository scope instead has no effect on the `deploy` job, which reads them through `environment: prod`:

| Name | Kind | Purpose |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Environment **variable** | The production project ID — the project `firebase deploy` ships *to*. Not sensitive. Consumed by the deploy step and the hosted smoke test's URL; it is *not* the job's `if:` gate — see above for why an environment-scoped variable cannot be one. |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_MEASUREMENT_ID` | Environment **variables** | The Firebase *client* config (Firebase console → Project settings → your web app), read by `src/firebaseConfig.ts` and **inlined into the client bundle at build time**. Public by design — they ship to every browser, and are protected by security rules and API-key restrictions rather than secrecy. Only these four are stored: `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_AUTH_DOMAIN`, and `VITE_FIREBASE_STORAGE_BUCKET` are derived from `FIREBASE_PROJECT_ID` in `ci.yml` by Firebase's naming convention, so one value is never written down twice. With them unset the build still succeeds and deploys, then fails in the browser with `auth/invalid-api-key`; `verify:client-config` exists to turn that into a build failure. |
| `FIREBASE_DEPLOY_SERVICE_ACCOUNT` | Environment **secret** | Inline service-account JSON with Hosting, Firestore rules/indexes, and Storage rules deploy permissions. Distinct from any credential `library:upload`/CNT-000 uses, so the deploy pipeline's IAM scope doesn't have to match a different task's. |
| `VITE_SENTRY_DSN` | Environment **variable** | The client DSN (`FND-001c`). **Public by design**: it ships in the client bundle, because a browser SDK cannot submit an event without it. It identifies an ingest endpoint and grants nothing else — the same standing as the Firebase Web API key. Stored as a variable, not a secret, so nothing pretends otherwise. |
| `SENTRY_ORG` | Environment **variable** | Sentry organization slug. Not sensitive. |
| `SENTRY_PROJECT` | Environment **variable** | Sentry project slug. Not sensitive. |
| `SENTRY_AUTH_TOKEN` | Environment **secret** | Creates releases and uploads source maps (`project:releases`, `org:read`). This is the one genuinely secret Sentry value — it can rewrite what your error data says. **CI only**: it never belongs in a developer `.env`, and `verify:bundle` fails the build if it ever appears in the output. |

### Per-PR preview deploys

`.github/workflows/preview.yml` publishes a pull request to a **Firebase Hosting preview channel** — an extra Hosting release inside the same production project, served from `https://<project-id>--pr-<n>-<hash>.web.app` and expiring after 7 days. It is a separate workflow from `ci.yml` because it deploys, and because owning the `labeled` trigger there would make adding any label cancel and restart the whole CI matrix.

**It is opt-in.** Add the `deploy-preview` label to a PR and it deploys; push again with the label on and the same channel is reused, so the URL in the review thread never goes stale. Remove the label (or never add it) and nothing happens. Closing the PR deletes the channel.

**What a preview shares with production, and what it doesn't.** Only Hosting is per-channel. Firestore, Authentication, and Storage are project-level, so a preview runs against the **live production backend** — which is the point (a reviewer sees the branch against real data) and also the entire risk surface:

- **It writes real data.** Anything created in a preview is a real document in the production database, owned by whoever signed in. Rules are owner-scoped so the blast radius is that account, but a PR that changes a persistence or migration path is writing schema-v1 documents the cohort will later read. Previewing `src/persistence` changes deserves more thought than previewing a panel's styling.
- **The factory library is read from the production bucket, over CORS.** A preview serves the app from `https://<project-id>--pr-<n>-<hash>.web.app`, but `library:build`'s output is not in the Hosting artefact, so the library browser fetches the pack index and manifests from Cloud Storage cross-origin. Cloud Storage matches a CORS origin as an exact string with no subdomain wildcard, and a channel's hash is minted at deploy time, so `storage.cors.json` admits any origin for GET/HEAD rather than a list that would exclude every preview (issue #259). A policy change there only takes effect once it is applied to the bucket — `bun run library:upload -- --configure-bucket` — which no workflow does automatically.
- **Rules and indexes are not deployed.** `hosting:channel:deploy` ships static files only, so a preview always runs against production's current `firestore.rules` and `storage.rules`, never the branch's. That is deliberate in both directions: an unreviewed branch must not be able to relax production's access rules, and a PR whose feature *needs* new rules cannot be proven this way — that stays the emulator suite's job (`bun run test:emulator`).
- **Labelling runs the PR's code with the production deploy credential in scope.** Reading the diff before labelling is the only control, exactly as it is for anything else that reaches production. Treat the label as a deploy approval, not a convenience.
- **It reports no analytics and no errors.** The job deliberately omits `VITE_FIREBASE_MEASUREMENT_ID`, `VITE_SENTRY_DSN`, and the three `SENTRY_*` build values, so `loadAnalytics()` resolves `null` and `sentrySink.start()` resolves false. Unreviewed branch traffic never lands in production's product analytics or error budget, and a preview never registers a Sentry release. The trade-off is the obvious one: a preview cannot be used to verify OPS-02/OPS-03 wiring — that is `OPS-001`'s job against a real deploy.

The job runs `bun run build && bun run verify:bundle && bun run verify:client-config` explicitly rather than `bun run deploy`, because `predeploy` only fires for the script it is attached to and `bun run deploy` would ship rules to the live channel. It then runs the same `smoke:hosted` suite against the channel URL — the only check that the preview actually signs in and plays audio. That smoke test creates one project as the QA account `testuser0` in the production database per preview deploy and deletes it again by its ID, the same as a production deploy does per merge. A fork's pull request gets no secrets, so there the signed-in test skips.

**Configuration.** The job declares `environment: prod` and reads exactly the values the `deploy` job already needs (table above) — there is nothing new to add. Two one-time steps: create the `deploy-preview` label on the repository (Issues → Labels), since a label that does not exist cannot be applied; and grant the IAM role below. One IAM note: the Firebase CLI also syncs each new channel URL into Firebase Authentication's authorized-domain list, which is what makes `signInWithPopup` (Google sign-in) work on a preview. That sync needs the deploy service account to hold Firebase Authentication admin permission in addition to its Hosting/rules permissions. Without it the deploy still succeeds and anonymous start — the app's own entry path — still works, so it is not gated on; Google sign-in on the preview URL is what breaks.

### Release SHA

`vite.config.ts` stamps the deployed git commit SHA into `import.meta.env.VITE_RELEASE_SHA` at build time (`src/release.ts` reads it, `src/components/ReleaseBadge.tsx` renders it). Resolution order: an explicit `VITE_RELEASE_SHA` (what the `deploy` job sets), then `GITHUB_SHA` (set automatically in every Actions run, including the unconditional `build` job), then `git rev-parse HEAD` for a local build, then the `"unknown"` sentinel if even `git` fails — stamping must never be able to block a build. `FND-001c` reads `RELEASE_SHA` to attach the release to every analytics and error event.

### The client bundle carries a usable Firebase config

`scripts/verify-client-config.mjs` is the mirror image of the secret scan below: that one fails when something private *is* in the bundle, this one fails when something public is *missing* from it. `src/firebaseConfig.ts` reads `import.meta.env.VITE_FIREBASE_*`, which Vite inlines at build time; with those unset outside mock mode every field becomes `undefined`, the build still succeeds, the secret scan still passes, and `firebase deploy` still reports success — then the first Auth call in the browser throws `auth/invalid-api-key` and the app renders its error boundary instead of the page.

That is exactly what shipped on `d65077c`, where a fully green deploy put an app live that could not start a session; the post-deploy smoke test was the only thing that caught it, after the fact. A missing build-time constant is a build defect, so `predeploy` now fails on it before `firebase deploy` runs. The check asserts the presence and shape of the four fields whose absence breaks startup (`apiKey`, `authDomain`, `projectId`, `appId`) — it cannot tell a valid key from a revoked one, which remains the smoke test's job.

### No secret reaches the client bundle

`scripts/verify-no-secrets-in-bundle.mjs` scans a built Hosting output directory for the *shape* of server-only credentials — PEM private keys, embedded service-account JSON, AWS/GitHub token patterns, and raw `NAME=value` assignments of the server-only secret names this project uses. It deliberately does not flag Firebase's own client config values (API key, app ID, and — once `FND-001c` lands — the Sentry DSN): those are public-by-design, protected by security rules and project scoping rather than secrecy, and are meant to ship to the browser. `scripts/verify-no-secrets-in-bundle.test.mjs` proves both halves: real secret shapes are caught, and a realistic Firebase client config is not a false positive.

### Marking internal/team traffic

A browser is marked as internal traffic in two ways, both persisted in its `localStorage` (`src/shared/internalTraffic.ts`):

- **Signing in as a team or test account.** `isInternalAccount` lists them: the product owner, the `groovetestuser<n>@gmail.com` accounts used for hands-on testing, and every QA-pool address on `qa.trygroove.app` (#1055). `AuthProvider` marks the browser the moment one of them signs in, so nobody has to remember a URL. The mark is one-way: it stays after a sign-out or a cohort account's sign-in in the same browser.
- **Visiting with `?internal=1`** (e.g. `https://trygroove.app/?internal=1`), for a browser none of those accounts has signed into. `?internal=0` clears the flag either way, so a team member can see the cohort experience as it is measured.

A marked browser sends two things to GA4. The `internal` user property (`"true"`) is a custom dimension for *reading* reports. GA4's reserved `traffic_type: internal` event parameter is what the property's **Internal Traffic data filter** *excludes*; it is set as a default parameter before gtag is configured (`loadAnalytics` in `src/firebaseConfig.ts`), so `session_start` and `page_view` carry it too, and again when an internal account signs in part-way through a load (`src/analytics/firebaseTransport.ts`). The first-ever load of a browser before its first internal sign-in is the one window that is not marked.

The filter is a property setting, not code: in GA4, *Admin → Data settings → Data filters*, the default **Internal Traffic** filter (matching `traffic_type` equals `internal`, the default rule under *Data streams → Configure tag settings → Define internal traffic*) must be set to **Active**, not *Testing*. In Testing it only labels the sessions with a `Test data filter name` dimension; only Active drops them from reports, and it is not retroactive.

### Post-deploy smoke test

`tests/e2e/hosted/smoke.spec.ts` (config: `tests/e2e/hosted/playwright.config.ts`, command: `bun run smoke:hosted`) is a separate Playwright suite from `tests/e2e/emulator/`: it requires `SMOKE_URL` (the real deployed Hosting URL) and drives real Firebase Authentication and Firestore, never the mock backend. Signed out, it checks the landing page, that `/projects` keeps a visitor with no session out, and the not-on-the-alpha-list page. Signed in, it covers PRD OPS-01's list — app load, session start, project open, and audio start after a user gesture — as the allowlisted QA account `testuser0` (#1055; anonymous start was retired by #854): `tests/e2e/hosted/qaSession.ts` signs a custom token for it with the `QA_SIGN_IN_SERVICE_ACCOUNT` key and installs the session in the page (setup: [`docs/runbooks/alpha-allowlist.md`](./runbooks/alpha-allowlist.md#signing-ci-in-as-a-qa-account)). It creates a project, clicks the transport's play button, and then deletes **only that project**, by its ID, because the deploy's smoke test and several previews can be signed in as `testuser0` at once. The deploy and preview jobs pass the secret, and the `VITE_FIREBASE_API_KEY` the build used, to that step alone; without the secret (a fork's pull request) the signed-in test skips and says why. Every first page load carries `?internal=1`, so smoke traffic stays out of the product's measures. It cannot run without a real deployed URL, so it has never been executed against a real environment as part of this task; the `deploy` job is where it runs for real, once the project above exists.

### Scheduled QA sweep

`.github/workflows/qa-sweep.yml` sends a few agents at the live app every Monday, or whenever it is run by hand from the Actions tab. It is exploratory testing, not a gate: nothing waits on it, and what it produces is Linear issues.

- **Plan.** `scripts/qa-sweep/plan.mjs` picks the flows: the next few in a weekly rotation through `docs/core-flows.md`, so successive runs cover the whole register, or the ones named in the `flows` input. A flow whose spec is still `test.fixme` is walked too, as *parked*: its agent is told the unbuilt parts are not bugs.
- **Explore.** One job per flow. `session.sweep.ts` signs agent slot *n* in as the QA account `testuser<n>` (#1055; the plan gives each flow its `slot`, 1 to 10), through `tests/e2e/hosted/qaSession.ts`: the `QA_SIGN_IN_SERVICE_ACCOUNT` key signs a Firebase custom token for the account, Node exchanges it for a session, and the session goes into the page's IndexedDB under the build's web API key, read from the site's `/__/firebase/init.json` (setup and why: [`docs/runbooks/alpha-allowlist.md`](./runbooks/alpha-allowlist.md#signing-ci-in-as-a-qa-account)). The key is that one step's env and nothing else's, so the agent never sees it. The session is marked as internal traffic (`?internal=1`), it opens `/projects`, and it records the live build's SHA. No two agents share an account, so each owns only its own projects and cannot touch anyone else's. Before the agent starts, a step with the Linear key (that step's env only) writes the open issues to `tmp/qa-sweep/open-issues.json`, so the agent can name a duplicate without a key of its own. The agent follows [`.github/qa-sweep/explorer.md`](../.github/qa-sweep/explorer.md): walk the flow, then try odd input, rapid clicks, keyboard-only use, resizing and reloads on everything it reached, and write `findings.json`. Its specs import `tests/e2e/hosted/qa-sweep/fixtures.ts`, which fails any test that is no longer signed in as the agent's account. Then, whatever the agent did, `cleanup.sweep.ts` deletes every project the account owns, so the slot starts the next run empty, and records the result; it reports nothing left only when it is signed in as that slot's account. The workflow's `concurrency: qa-sweep` keeps two runs from sharing a slot.
- **File.** `scripts/qa-sweep/file.mjs` is the only step that writes to Linear (the agents have no key, and a read-only GitHub token). It files each new finding as a `Bug: …` issue (symptom, expected, steps, environment with the live build's SHA, a screenshot published to `claude/walkthroughs`), which the board's poll then milestones; a finding the agent rates low risk (confined to what is on screen, nothing about saved projects, access, uploads, export or playback) goes straight into Ready, so the board builds it, and anything else into Backlog; comments on an open issue instead when the agent named it as the duplicate or the titles match; and posts the run summary (flows covered, issues filed, issues re-seen, anything over the cap, cleanup) as an **update on the Groove project** in Linear, leaving the project's health as it was. The same summary goes in the run's job summary. Each write stands alone: one Linear refuses (a rate limit, a 5xx) is listed in the summary and turns the run red, and the rest still go. Agent text is pasted in with its `@mentions` broken, so a finding can neither start a Claude run nor ping anyone, and every body is cut well short of what an issue may hold. A screenshot is published only if it is a real PNG inside the agent's output directory; symlinks are deleted before the report is uploaded.
- **Budget.** At most 5 agents and 15 new issues a run, across all agents. Change them per run with the `agents` and `issues` inputs, or for every run with the `QA_SWEEP_MAX_AGENTS` and `QA_SWEEP_MAX_ISSUES` repository variables; either is clamped to 10 and 50. When the cap bites, the most severe findings are filed first and the rest are listed in the summary. Re-seen issues do not count towards it. `dry_run` walks and reports but writes nothing to Linear.
- **Running the harness by hand.** With `QA_SWEEP_SLOT` and `QA_SIGN_IN_SERVICE_ACCOUNT` (the key's JSON) set, `bunx playwright test --config=tests/e2e/hosted/qa-sweep/playwright.config.ts --project=explore` runs whatever specs are in `tmp/qa-sweep/specs/` signed in as that slot's account (signed in on the first run, reused after), and `--project=cleanup` deletes that account's projects. Delete `tmp/qa-sweep/` to sign in afresh. Do not use a slot while a scheduled or dispatched run might be using it.

The sweep cannot delete a pack an agent uploads sounds into, so the brief tells agents not to upload any; that part of a flow is explored up to the upload.

### Rollback

Rollback is a practiced, documented operation, not an improvisation (PRD OPS-01) — but it needs the same real production project as the rest of this section, and this task does not have one to practice against. The procedure:

1. **Hosting**: `firebase-tools` 15 has no `hosting:versions:list` command (`firebase hosting --help` lists only `hosting:clone`, `hosting:disable`, `hosting:channel`, and `hosting:sites`) — find `<PREVIOUS_VERSION_ID>` in the Firebase console's Hosting release history instead (Hosting → your site → Release history), which also offers a one-click Rollback button as an alternative to the CLI step below. With the version ID in hand, `firebase hosting:clone <site-id>@<PREVIOUS_VERSION_ID> <site-id>:live --project "$FIREBASE_PROJECT_ID"` republishes it as the live release immediately, without rebuilding. The separator differs on purpose and the command is silent about getting it wrong: `hosting:clone` splits the source on `:` first and only falls back to `@` if that yields fewer than two parts, so a `<site-id>:<PREVIOUS_VERSION_ID>` source is read as a *channel* named after the version and fails with `Could not find the channel <PREVIOUS_VERSION_ID> for site <site-id>`. The target keeps `:live`, which really is a channel. For the default site, `<site-id>` is the project ID.
2. **Firestore rules**: every past `firestore.rules` revision is already in git history against the commit SHA its `deploy` job run stamped. `firebase.json`'s `firestore.rules` path always points at the working tree's `./firestore.rules`, so the rollback must overwrite that file, not a copy elsewhere: `git checkout <previous-commit> -- firestore.rules && firebase deploy --only firestore:rules --project "$FIREBASE_PROJECT_ID"`. Immediately commit that reverted `firestore.rules` (or restore it with `git checkout HEAD -- firestore.rules` once the incident is resolved) so the working tree and the deployed rules do not silently diverge.
3. Confirm with the smoke test (`bun run smoke:hosted`) before considering the rollback complete.

Because Hosting release history and Firestore rules revisions are both associated with the commit SHA `ReleaseBadge` and the analytics/error catalog carry, an incident report can name exactly which release is live before and after the rollback.

## Analytics and error monitoring

| Field | Value |
| --- | --- |
| Status | Implemented (`FND-001c`) |
| Scope | The typed analytics catalog, the logging boundary, the error-reporting boundary and its Sentry sink, consent/opt-out, source-map upload, and release registration |

Related: [PRD 10 Security and privacy](./prd.md#10-non-functional-requirements), [ADR 0001](./adr/0001-sentry-for-error-monitoring.md)

### What is checked without a deployed build

Most of this layer is verified in the ordinary `bun run test` suite, deliberately — a criterion that can only be checked by looking at a vendor dashboard is a criterion that quietly stops being checked.

| Suite | What it proves |
| --- | --- |
| `src/analytics/catalog.test.ts` | Every PRD `OPS-02` event is declared with its parameters and allowed values, and the persistence failure reasons stay in step with `ERROR_CODES`. |
| `src/analytics/analytics.test.ts` | Enrichment (release SHA, surface, account-type user property), runtime validation, once-only events, and fail-open behavior. Includes `@ts-expect-error` cases: logging an unregistered event, parameter, or value is a **compile** error. |
| `src/analytics/consent.test.ts` | The opt-out persists, applies to both processors independently, and survives hostile or absent storage. |
| `src/monitoring/scrub.test.ts` | The no-PII criterion, run over the scrubbing functions directly against a deliberately hostile payload — so it also covers events and breadcrumbs added by later tasks. |
| `src/monitoring/errorReporting.test.ts` | One report per error, duplicates collapsed, fatal/non-fatal carried, and no recursion or caller impact when a sink throws. |
| `src/monitoring/globalHandlers.test.ts` | `error` and `unhandledrejection` each report once, as fatal, and dispose cleanly. |
| `src/monitoring/sentrySink.test.ts` | The ADR 0001 configuration as facts: `sendDefaultPii` off, console breadcrumbs disabled, minimal integration set, Release Health on. Per [ADR 0002](./adr/0002-sentry-session-replay.md), **Session Replay is enabled with masking on**: all text masked, all media blocked, canvas capture off, error-triggered replay at zero. Injects a fake SDK module, so no test loads Sentry. |
| `src/monitoring/boundaries.test.ts` | `@sentry/*` is imported by `sentrySink.ts` and nothing else, it is absent from the barrel, and `telemetry.ts` reaches it only through a dynamic `import()`. |
| `src/telemetry.test.ts` | The SDK loads only after first paint and never on the landing page, and the **core journey (edit → save → undo) is identical** with both transports throwing and the user opted out. |
| `bun run verify:budget` | The SDK contributes **zero bytes** before first paint, measured against the built output rather than assumed (see below). |

### Bundle cost

```sh
bun run build && bun run verify:budget
```

`scripts/verify-bundle-budget.mjs` walks the entry script and every module `index.html` preloads, follows their *static* imports transitively, and fails if the Sentry SDK appears anywhere in that closure — which is what the PRD section 10 "interactive within 3 seconds" budget actually requires of monitoring. It then measures the lazy chunk's brotli size against a declared ceiling, so an SDK upgrade that doubles it is a decision rather than a surprise. The `build` CI job runs it on every push and PR.

### Source maps and release registration

Three separate mechanisms, one per clause of the acceptance criterion:

1. **Produced** — `vite.config.ts` sets `build.sourcemap: "hidden"`, so a map is emitted for every chunk with no `//# sourceMappingURL=` comment pointing at it.
2. **Uploaded over an authenticated channel** — `@sentry/vite-plugin` runs during the `deploy` job's `predeploy` build (the only moment the deployed artifacts and their maps both exist), authenticating with the CI-only `SENTRY_AUTH_TOKEN`. It also registers the release under the deployed commit SHA and injects **debug IDs** into both chunk and map, so Sentry matches them by ID rather than by URL.
3. **Never served publicly from Hosting** — the plugin deletes the maps after upload, and `firebase.json`'s `hosting.ignore` refuses to upload `**/*.map` regardless. The second is the guarantee that does not depend on the first having run: a local build, or a build with no Sentry credentials, still cannot publish a map.

After the deploy succeeds, a separate step marks the release deployed (`sentry-cli releases deploys … new --env alpha`), so Sentry's "first seen in" and regression detection line up with real deploys rather than with build times.

### Verifying analytics and errors against a deployed build

Neither GA4 nor Sentry can be verified from the unit suite — the last mile is a real browser talking to a real project. This is the procedure; it needs the hosted environment and the credentials in the table above to exist.

**Before you start.** Open the site and confirm `ReleaseBadge` shows the SHA you expect; every check below is scoped to that release. Then open the Privacy disclosure in the footer and make sure collection is **on** — an opted-out browser correctly sends nothing, which looks identical to a broken pipeline. Disable any ad or tracker blocker: both `google-analytics.com` and `sentry.io` are commonly blocked, and a blocked endpoint is invisible by design (PRD `OPS-02`).

**1. Alpha Milestone 0 events.** In GA4, open *Reports → Realtime* (events appear within seconds; the standard reports lag by up to 24 hours) or *Admin → DebugView* if you appended `?debug_mode=1`. Then, on the deployed site:

| Event | How to trigger it | Check |
| --- | --- | --- |
| `app_opened` | Load `/projects` or a project. Then, in a fresh session, load `/` and click through to the dashboard — that navigation is client-side, so it must be checked separately. Staying on the landing page fires nothing; that surface measures `landing_cta_click` instead. | Fires once per app load on reaching the dashboard or editor, whichever way the session got there, with `surface` and `release_sha`. |
| `landing_cta_click` | On `/`, click each "Request an invite" (header, hero, closing) and "See what's inside". Then, in a fresh session, click "Sign in". | Fires once per click, with `cta_id: request_access`, `see_inside` or `log_in`, its `placement` (`header`, `hero` or `close`) and `surface: landing`. (`start_free` is guest start's, retired by #854.) The first of them in a browser also fires `feature_first_use` with `feature: landing_v2`. |
| `landing_video_play` | Load `/` with reduced motion off. Then load it with reduced motion on. | Fires once per page view when the hero video starts, with `surface: landing`; never under reduced motion, where the poster stays up. |
| `sign_in_blocked` | Sign in with a Google address that is not on the alpha allowlist (#854). | Fires once per refusal, with `source: landing` (or `log_in`/`upgrade` from a guest session), and no address. |
| `allowlist_approved` | As an admin, approve addresses on `/admin` (#854). | Fires once per approval, with `source: paste` or `attempt` and the three counts, and no address. |
| `access_revoked` | As an admin, Revoke an address on `/admin` and confirm (#1147). | Fires once per revocation, with `was_listed` and `sessions_ended`, and no address. |
| `assistant_retention_changed` | Answer the assistant's disclosure, then change the answer in the panel's Assistant settings (GRV-8). | Fires once per answer stored, with `state: on` or `off` and nothing else; the first also fires `feature_first_use` with `feature: assistant_retention`. With collection off, the answer is still stored. |
| `first_edit` | Make the first edit in a project. | Fires once for that project, never again — reload and edit again to confirm. |
| `feature_first_use` | Use a feature for the first time in that browser. | Fires once per `feature`, carrying the feature key. |
| `save_failed` | Go offline (DevTools → Network → Offline) and make an edit. | Fires with a stable `error_code` and a `retry_count`. |
| `audio_start_failed` | Load a project and press play *without* interacting first, so autoplay is blocked. | Fires with `error_code: autoplay_blocked` and `was_browser_blocked: true`. |
| `exception` | Trigger the test error in step 2. | Fires with `fatal`, `area`, and `error_code` — and **no message**. |

Confirm the `account_type` and `internal` user properties are set under *Admin → Custom definitions*. Signing in as the product owner marks your browser as internal traffic (see "Marking internal/team traffic"); use `?internal=1` first if you verify signed out, so your verification traffic can be excluded from the section 11 measures. In the DebugView event details, every event should show `traffic_type: internal`.

**2. A deliberately triggered error.** From the deployed site's console, throw an error that no application code catches, so it takes the real path — global handler → reporting boundary → Sentry *and* the GA4 `exception` counter:

```js
setTimeout(() => { throw new Error("solid-groove deploy verification"); });
```

Use `Promise.reject(new Error("solid-groove deploy verification"))` to exercise the `unhandledrejection` handler instead. This needs no application code: adding a "throw a test error" control to the product would be a permanent user-facing surface in exchange for a one-off check.

**The `setTimeout` wrapper is load-bearing — do not simplify it to a bare `throw`.** Typing `throw new Error("...")` straight at the DevTools prompt prints a red "Uncaught Error" but dispatches **no** `window` `error` event: the REPL catches it as the evaluation's completion value. Our global handler never sees it, nothing is reported, and the console output is indistinguishable from a working throw that Sentry dropped. Deferring the throw makes it escape to the real `window.onerror`, which is the path a genuine error takes.

**Allow ~30 seconds** for the issue to appear, and sort the feed by *Last Seen*. Measured against the production project on 2026-08-06, latency from throw to visible was around half a minute. Both of these traps were hit for real on 2026-08-06 and each, on its own, looks exactly like broken monitoring — check the throw form and wait out the latency before concluding anything was dropped.

In Sentry, the issue should show:

- the **release** equal to the deployed commit SHA, and *Deploys* listing the `alpha` deploy for it;
- a **symbolicated stack trace** naming `src/` files and real line numbers — if frames are minified, the source-map upload did not run (check `SENTRY_AUTH_TOKEN` in the deploy log) or the debug IDs did not match;
  - **A console throw cannot prove this.** Its stack is `<anonymous>:1:7` — there are no bundled frames, so there is nothing to symbolicate, and the issue will show no `src/` files however healthy the maps are. That is not a symbolication failure. To get real frames, trigger the error from *inside* deployed app code, so the stack passes through a bundled chunk. **Do not add a "throw" Easter egg to the product for this** — it would be a permanent user-reachable path shipped for a one-off check, could fire accidentally and pollute real crash data, and is the same trade-off rejected above.
  - **Check the artifacts directly instead**, which needs no error at all and answers the same question:
    ```sh
    bunx sentry-cli releases files "<release-sha>" list --org "$SENTRY_ORG" --project "$SENTRY_PROJECT"
    ```
    Or read the `deploy` job log: `[sentry-vite-plugin] Info: Successfully uploaded source maps to Sentry`, preceded by a *Source Map Upload Report* pairing each `.js` with its `.map` and a shared **debug id**. Matching debug IDs are what symbolication actually resolves on — URLs and release names are not consulted. Verified present for release `9e109fee` in [run 31104650815](https://github.com/trygroove/groove/actions/runs/31104650815).
- `area`, `error_code`, `fatal`, and `browser_*` tags, and a **redacted** message;
- **no** `request`, `user`, `extra`, or `server_name`, and no console breadcrumbs.

Session Replay ([ADR 0002](./adr/0002-sentry-session-replay.md)) is checked separately, because "a replay exists" is not the thing that matters — what it contains is. Open a sampled replay from *Replays* and confirm it shows interaction (pointer, clicks, navigation, timing) while every piece of user-authored content — track and clip names, the arrangement, note data, assistant messages, and anything typed — is masked or blocked. An unmasked clip name is a release blocker, not a cosmetic defect. Then confirm that with telemetry declined no replay is produced at all.

Then confirm the same error produced exactly **one** issue (not two — Sentry's own global handlers are switched off so ours is the only capture point) and that *Releases → Health* shows a crash-free session rate for that release.

**3. The opt-out.** Turn collection off in the Privacy disclosure, repeat steps 1 and 2, and confirm nothing new arrives at either processor while every feature still works. Turn it back on and confirm collection resumes — the toggle is symmetric, and a grant that does not resume collection is as much a bug as a withdrawal that does not stop it.

Check GA4's *automatic* collection too, not just the custom events: it is a separate channel that no transport controls (`setAnalyticsCollectionEnabled`, `src/firebaseConfig.ts`). With collection off, *Realtime* must show no new `page_view`, `session_start`, or `user_engagement` for the session. Then reload with collection still off, navigate around, and confirm the same — a session that declines before the SDK is initialized never initializes it, so no `_ga` cookie should be written at all (DevTools → Application → Cookies).

**4. No source map is public.** Fetch a bundle and its would-be map directly:

```sh
curl -s "https://trygroove.app/_build/assets/<chunk>.js" | head -c 60
curl -s "https://trygroove.app/_build/assets/<chunk>.js.map" | head -c 60
```

The first must return JavaScript. The second must return the SPA shell — `<!DOCTYPE html>...` — and **not** JSON beginning `{"version":3,...`.

**Do not test this with `curl -sI` and a status code.** `firebase.json` rewrites `**` to `/index.html`, so *every* path that does not exist on Hosting returns `200 text/html`, including `/nope-does-not-exist.map`. A 200 here is therefore expected and proves nothing either way; only the body distinguishes a served map from the catch-all. An earlier version of this check compared status codes, and would have reported a leak on every correct deploy. If the body really is a source map, `hosting.ignore` (`**/*.map`) is not doing its job and the deploy should be treated as a leak.

### Verifying assistant transcript retention against a deployed build

Groove keeps a conversation with the assistant only for an account that said yes in its disclosure, and for 30 days from each message (GRV-8, `src/assistant/transcripts.ts`). Nothing in the browser can read the store (`firestore.rules` denies every client), so both checks read it in the Firebase console, or with the Admin SDK, as someone with access to the project.

**Declining leaves nothing.** Sign in as a fresh test account (a `groovetestuser<n>` address, so it is marked internal), open a project and the assistant, and press **Don't keep them**. Send a few messages, and apply, cancel and undo a proposal. In the console, `assistantPreferences/{uid}` reads `retain: false`, and *Firestore → assistantTranscripts*, filtered on `uid == <uid>`, has no documents. Then open **Assistant settings** in the panel, tick the box, send one message, and confirm exactly one document appears for that uid (with `internal: true`). Untick it: the panel says the kept conversations were deleted, and the filter is empty again.

**An expired transcript is gone.** In the console, take one kept document and set its `createdAt` and `expiresAt` back by 31 days (`expiresAt` is `createdAt` plus 30 days, in milliseconds). Within the hour the `purgeExpiredTranscripts` function runs (*Functions → Logs*: "expired assistant transcripts deleted" with a count of at least 1) and the document is gone; the account's other documents are still there. To check without waiting, run the job from *Cloud Scheduler → firebase-schedule-purgeExpiredTranscripts-… → Force run*.

**Deleting a project or an account takes its transcripts.** Delete a project that has kept transcripts from the dashboard and confirm, filtering on `projectId`, that they are gone ("a deleted project's assistant transcripts deleted" in the logs). Deleting the test account in *Authentication* removes its transcripts and its `assistantPreferences` document the same way.

The emulator suite (`tests/emulator/assistantTranscripts.emulator.test.ts`) covers the same rules against a local Firestore on every CI run; this check is for the deployed functions, schedule and triggers, which it cannot reach.

### What has been verified against the hosted environment

`OPS-001` ([issue #68](https://github.com/trygroove/groove/issues/68)) ran on **2026-08-05** against release **`8336d9d`** on the production project `groove-35c07` (`https://groove-35c07.web.app`), and the error-monitoring items were re-checked the same day against release **`e15ce13`** once [#174](https://github.com/trygroove/groove/issues/174) was fixed. What follows is what was observed, not what the procedure says should happen. Anything not listed as verified below is either outstanding or descoped, and must not be cited as evidence.

**Verified.**

- **Deploy from CI on merge to `main`** — [run 31007337948](https://github.com/trygroove/groove/actions/runs/31007337948) shipped Hosting, Firestore rules and indexes, and Storage rules in one `firebase deploy`. Every step green. The site loads and its `ReleaseBadge` shows the deployed commit SHA.
- **Post-deploy smoke test** — passed against the hosted URL in that same run: app load, anonymous session start, project open, and audio start after a user gesture. It has also been shown to *fail* a deploy for real: [run 31000409583](https://github.com/trygroove/groove/actions/runs/31000409583) went red when release `d65077c` shipped without its Firebase client config, which is what caught that defect (fixed in #169).
- **Rollback drill, performed** — rolled back to Hosting version `ed1256`, confirmed with the smoke test while rolled back, then rolled forward to version `53042d`. The `firestore.rules` revision restored alongside it was commit `8336d9d2`.
- **Analytics opt-out, both directions** — collection toggled off in the Privacy disclosure (no further events observed in GA4), then back on (collection resumed). The toggle is symmetric in practice, not just by construction.
- **OPS-02 events arriving from the deployed build** — `session_start`, `first_visit`, `page_view`, `feature_first_use`, and `clip_edited` observed in GA4 with their expected parameters.
- **No source map is publicly fetchable** — confirmed by request against the deployed chunks. Note the check must compare response *bodies*, not status codes; see "4. No source map is public" above for why a `200` here proves nothing.
- **Error monitoring initializes and delivers from the deployed build** — on release `e15ce13`, an uncaught error dispatched through the app's own global handler reached Sentry's ingest endpoint with **HTTP 200**, alongside the Release Health session envelope. Checked in a *hidden* tab specifically, which is where it used to fail: `window.__SENTRY__` is live, the `sentrySink-*` chunk is fetched, and `globalThis.__sgMonitoring` reads `"started"`. This supersedes the [#174](https://github.com/trygroove/groove/issues/174) defect recorded here against `8336d9d`, whose cause was `afterFirstPaint` waiting on a `requestAnimationFrame` that a hidden document never fires (fixed in [#176](https://github.com/trygroove/groove/pull/176)).

**Descoped.**

- **Computing the primary success measure from real events** is deferred to post-alpha (`DEC-011`, PRD section 16). The four events it would use still ship and are still covered by automated tests; what is deferred is defining and acting on the measure. This is a decision, not a gap.
- **Inspecting a delivered error in the Sentry UI** is deferred to post-alpha (`DEC-012`). Delivery itself is verified above: an uncaught error reaches ingest with HTTP 200 from the deployed build, so a crash in front of a real user *is* reported. What is deferred is confirming what the resulting issue looks like — the release SHA on it, a **symbolicated** stack naming `src/` files, the expected tags, a redacted message, one-issue-per-error, and a crash-free session rate under *Releases → Health*. Each is a property of the Sentry console rather than of the app, and every one is already covered by unit tests against a fake SDK (`src/monitoring/sentrySink.test.ts`, `scrub.test.ts`).
  - The half that fails silently in CI *is* confirmed: source maps uploaded for release `9e109fee` with debug IDs paired to every chunk ([run 31104650815](https://github.com/trygroove/groove/actions/runs/31104650815)). Symbolication resolves on those debug IDs, so the remaining risk is narrow.
  - **The residual risk, stated plainly:** if scrubbing were misconfigured in a way the unit tests do not model, a real error could carry user content into Sentry before anyone notices. That is the one item here worth revisiting early, and it is why this is recorded as accepted rather than dismissed.
- **Internal-traffic exclusion** is deferred to post-alpha (`DEC-012`). The marking (by account and by `?internal=1`) and the `traffic_type: internal` parameter are unit-tested, but neither the `internal` user property nor the parameter has been confirmed in GA4 from the deployed build, the Internal Traffic data filter still has to be switched to Active there, and internal traffic has not been shown to be excluded. The effect is that alpha-period measures may be inflated by the team's own sessions — which matters for *reading* the numbers, not for whether the product works, and the primary measure those numbers feed is itself deferred (`DEC-011`). Re-verify alongside it.

Both deferrals are the same call: these are operator-console checks that were absorbing attention better spent building the core product experience, and both are cheap to run once the alpha is built. Neither blocks the cohort, and neither is a defect — see PRD section 16 (`DEC-012`).

**Gate `G4.5: Hosted environment verified` is open** (2026-08-06). Everything the gate exists to protect has been observed against the hosted environment: the app deploys from CI, rolls back and forward, serves no source maps, collects analytics with a working opt-out, and reports uncaught errors to Sentry. `HARD-005` invites the cohort on the strength of this gate, and each of those is what a real alpha user depends on.

The two remaining checks are deferred by decision (`DEC-012`), not left unfinished, and neither affects a cohort session: one is how a delivered error *renders* in the Sentry console, the other is whose traffic the measures count. Both are recorded above with their residual risk.

## Test helpers

| Helper | Location | Purpose |
| --- | --- | --- |
| `createId`, `createSeededIdFactory`, `isPrefixedId` | `src/shared/id.ts` | The prefixed-ID format (`trk_...`, `clp_...`, ...). `createId` is the production generator; `createSeededIdFactory(seed)` is deterministic for fixtures and round-trip tests. One shared factory, not a separate test-only ID shape. |
| `systemClock`, `createManualClock` | `src/shared/clock.ts` | A `Clock` abstraction so domain code depends on an injectable clock instead of calling `Date.now()` directly. `createManualClock` never advances on its own — tests control time explicitly. |
| `parseOrThrow`, `safeParseWithIssues`, `finiteNumberInRange` | `src/shared/schema.ts` | The shared Zod entry point PRD section 9.1 commits to for runtime schemas. `parseOrThrow` fails closed (throws `SchemaValidationError`, never returns a partial value) per invariant 6; `finiteNumberInRange` is the shared clamping primitive invariant 4 asks for. `FND-002` builds the schema-v1 domain schemas on top of this rather than inventing its own parse/error shape. |
| `timeoutScheduler`, `createManualScheduler` | `src/shared/scheduler.ts` | A `Scheduler` abstraction for deferred work (autosave coalescing, backoff), so a test drives the delay explicitly instead of sleeping. Same rationale as `clock.ts`: production code is a consumer too. |
| `loadStoredProjectFixture` | `src/testing/fixtures.ts` | Loads a stored schema-vN project from `public/fixtures/persistence/v{version}-{name}.json`. The fixture convention the persistence migration harness follows — see [`docs/persistence.md`](./persistence.md). |
| `describeProjectRepositoryContract` | `src/persistence/projectRepositoryContract.ts` | The shared `ProjectRepository` contract suite. Any new repository implementation runs it; behavior specific to one implementation stays in that implementation's own test file. |
| `createSliceFixtureProject`, `createDrumMachineFixtureProject`, `createReferenceProject`, `sliceFixturePacks`, `drumMachineFixturePacks` | `src/domain/fixtures.ts` | Deterministic schema-v1 reference projects, seeded so two runs produce identical IDs and identical JSON. `createDrumMachineFixtureProject` is the **two-pack** fixture — its assets resolve from two packs at two versions, which a single-pack fixture cannot do, so use it for anything touching pack-qualified asset identity (invariant 12). The `*FixturePacks` helpers rebuild a fixture's `Pack` records from the same seed, and `availablePacksFor(project, packs)` turns them into the `AvailablePack[]` `resolvePackAvailability` takes — "the packs I have, still holding everything this project uses". Perturb one entry for the case under test: bump `pack.version` for a pack that gained a sound, drop an ID from `assetIds` for one that lost a sound, drop the entry for a pack that is gone. |
| `memoryStorage`, `hostileStorage` | `src/testing/storage.ts` | `Storage` doubles for anything that persists a preference or a marker (telemetry consent, once-only analytics events, the internal-traffic flag). `memoryStorage` isolates a test from jsdom's real `localStorage`, so a leaked opt-out cannot make suites pass or fail by order; `hostileStorage` throws on every operation, standing in for Safari private browsing and a full quota. |
| `createRecordingTransport`, `createFailingTransport` | `src/analytics/transport.ts` | Analytics transports for tests: one records events and user properties for assertions, the other throws on every call so a test can prove the PRD `OPS-02` fail-open requirement rather than assume it. |
| `loadFixtureJson` | `src/testing/fixtures.ts` | Browser-safe fixture loading: reads `public/fixtures/*.json` from disk under Node (unit/component/emulator suites) or fetches it as a static asset under a real browser, picking the strategy at call time. |

`src/shared/` holds helpers production code also depends on (both current and future domain code use `createId`/`Clock`); `src/testing/` holds helpers that only make sense inside a test.

## Why `firebase.json`'s `database` block was removed, not fixed

The prototype `firebase.json` pointed `database.rules.json` at a file that never existed, and nothing in the app uses the Realtime Database — only Firestore (`src/firebaseConfig.ts`) and Firebase Authentication. Supplying an unused `database.rules.json` just to satisfy the reference would add a maintenance burden for a service the product doesn't use; removing the `database` key resolves the dangling reference honestly. `firebase.json` now only declares `firestore` (rules) and `emulators` (`firestore` + `auth`, matching what the app and its tests actually exercise). Adding Realtime Database back is a normal follow-up if a future task actually needs it.

## Generated sample audio and the test suites

`scripts/generate-samples.mjs` (idempotent — it only writes files that are missing) runs via `predev`/`prebuild`, and now also via `pretest:browser:emulator`, since the E2E suite loads the real app, which needs `public/samples/*` to exist. It intentionally does **not** run before `test` or `test:emulator`: neither suite serves the app or touches sample audio, so running it there would be pure overhead on every invocation.

## Starter sound library

```sh
bun run library                     # print the workflow and the current on-disk state
bun run library:test                # the library suites only, without the rest of `bun run test`
bun run library:build               # render synthesized assets, merge acquired, write the manifest
bun run library:audition            # listen to the merged library at http://127.0.0.1:4180
bun run library:validate            # build and validate without writing anything
bun run library:audit               # decode, loudness, tuning, loop, missing-file, duplicate and per-pack audits
bun run library:emit-runtime        # regenerate src/library/factoryLibrary.generated.ts
bun run library:upload              # publish to Cloud Storage (see .env.example for credentials)
```

These scripts run under `node`, not `bun`, and Node does not read `.env` on its own the way Bun does — so every `node scripts/...` entry in `package.json` passes `--env-file-if-exists=.env`. Without it a value set correctly in `.env` is simply invisible to the script, which reports it as unset. The flag tolerates a missing `.env` (CI, fresh clones) and real environment variables still take precedence over the file, so CI behaviour is unchanged. `.env` is resolved relative to the **current directory**: run these from the repository root, and note that a git worktree has no `.env` of its own unless you put one there.

`bun run library` is the entry point: it prints the ordered workflow and reports
what has been built, pinned, and ingested, so the next step is stated rather than
inferred. `library:test` is the fast inner loop while changing the catalogue or
the pipeline; `library:audition` is the manual check no automated rule replaces —
the validator proves an asset is well-formed, not that it sounds right.

`scripts/starter-library/` produces the `LIB-00` testing library and publishes it to Cloud Storage. It has two halves: 200 **synthesized** one-shots that need no network and rebuild byte-for-byte, and an **acquisition** path for pinned CC0 downloads from the approved sources. [`docs/sample-library.md` section 15](./sample-library.md) covers both, the delivery layout, and how to add CC0 content.

`library:build` merges whatever `library:acquire` last ingested, so with nothing acquired it is the 200 synthesized assets and needs no network at all — which is why CI can gate on it unconditionally.

The library ships on the pack model (`docs/sample-library.md` sections 5.1 and 15.8, `CNT-000b`): the build emits one manifest per pack plus a pack index at `library/packs/...`, and the validator carries the section 9 pack rules alongside the section 6.4 rules, which are still measured across the whole library rather than per pack. The commands above are unchanged — `library:build`, `library:validate`, and `library:upload` all operate on every pack in one call.

`CNT-001` generalized the same pipeline past one-shots (`docs/sample-library.md` section 15.9): it now also produces bar-aligned **loops** with a measured tempo grid and a 32-cycle seam check, **presets** (drum kits, multisample instruments, device chains) delivered as content-addressed JSON that references assets by ID, and **derived masters** that record their source's checksum. `scripts/starter-library/ingestion.test.mjs` drives every new validation rule from a fixture that violates it, and `scripts/starter-library/intake.mjs` implements the section 11 intake ladder — anything below `metadata-review`, plus anything whose bytes are missing or disagree with the manifest, is isolated from the published manifests and reported rather than failing the build.

**The application consumes the generated manifest.** `bun run library:emit-runtime` writes the committed `src/library/factoryLibrary.generated.ts` and renders the audio it points at into `public/samples/starter-library/audio/`. It runs from `bun run samples`, which `predev`, `prebuild`, and `pretest:browser:emulator` all call, so the browser suite serves the same content-addressed objects the bucket does. `scripts/starter-library/runtime.test.mjs` fails if the committed module no longer matches a fresh emit, and `src/library/factoryLibrary.test.ts` covers the application side; the file is excluded from Biome in `biome.json`, because a formatter rewrapping a line would make the committed file differ from a fresh emit for no reason (`tsc` still checks it).

### Acquisition tests

`scripts/starter-library/acquire.test.mjs` exercises the whole acquisition path offline, against fixtures the test builds itself and serves over `file://`: a generated 44.1 kHz WAV is zipped, "downloaded", checksum-verified, extracted by pinned member name, decoded and resampled through `node-web-audio-api`, prepared to the section 10 standard, turned into a manifest entry, and run through the shared validator. Every stage downstream of the URL is the real implementation, so this proves the pipeline works rather than proving a mock matches a mock.

The rights rules are tested as behaviour, not documentation: a lockfile entry with a missing checksum, an unnamed reviewer, an unapproved licence, or acquired audio claiming `sourceType: "synthesized"` all fail, and each rejected licence explains *why* it cannot be bundled.

One portability note, since it bit once already: `decodeAudioData` type-checks its argument against `globalThis.ArrayBuffer`, and under this suite's jsdom environment that is not the same constructor a Node `Buffer`'s `.buffer` came from. `acquire/audio.mjs` allocates through the ambient `ArrayBuffer` for that reason — reslicing the Buffer's own works under the CLI and fails under the test runner.

Its unit tests (`scripts/starter-library/*.test.mjs`) run under the normal `bun run test`, and are written to stay fast: rendering all 200 assets takes about 20 seconds, so most of the suite renders a handful of representative assets and drives the validation rules with fixtures. Two files are the deliberate exception — `ingestion.test.mjs` and `runtime.test.mjs` build the whole library once, because "every type carries the metadata the criteria require" and "the committed runtime module matches a fresh emit" are claims about the real catalogue, not about a fixture. **The full catalogue is validated by `bun run library:validate`**, which CI runs as its own step — that is what enforces the collection-level rules (role coverage, genre coverage, the section 6.4 balance floors, the metadata payload budget) against the real library rather than a fixture.

`library:validate` needs no credentials, no network, and no emulator: it renders in-process and throws on the first validation failure.

### Exercising upload without a real project

`bun run library:upload -- --dry-run` computes and prints the whole plan — every object path, its cache headers, and the total payload — without touching the network. To exercise the real client, point it at the Storage emulator (`firebase.json` declares it on port `9199`):

```sh
firebase emulators:start --only storage --project demo-solid-groove
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
  bun run library:upload -- --bucket demo-solid-groove.firebasestorage.app
```

A second run against the same emulator uploads nothing but the mutable pointers (each pack's `latest.json` and `packs/index.json`, always rewritten) and skips every immutable object — audio and versioned pack manifests alike. Bumping one pack's `version` in `packs.mjs` and re-running uploads exactly that pack's new manifest; every other pack's manifest and all audio stay skipped, which is what "a repack re-uploads no audio" and "a single changed pack re-uploads only that pack's manifest" (section 15.8) mean in practice, not just in the log line.

Two caveats, both emulator limitations rather than bugs:

- The Admin SDK routes *writes* through `FIREBASE_STORAGE_EMULATOR_HOST` but metadata reads through `@google-cloud/storage`, which reads `STORAGE_EMULATOR_HOST` and wants a scheme. `upload.mjs` derives the second from the first, so setting only the documented variable works.
- The emulator answers `setCorsConfiguration` with "Not Implemented" and serves permissive CORS anyway, so `--configure-bucket` reports CORS as skipped there. Bucket CORS can only be verified against a real bucket.

A second run of the same command should report every audio object and the versioned manifest as skipped, and rewrite only the mutable `latest.json` pointer — that is the idempotency check.

## `bun run clean`, and the stale-cache failure it exists for

```bash
bun run clean
```

Deletes `dist` (start mode's build output, which replaced `.vinxi` and `.output`), `node_modules/.vite`, and the `test-results` / `playwright-report` / `blob-report` / `vitest-report` output directories. It does **not** touch `node_modules` itself, so no reinstall is needed afterwards, and it leaves `public/samples` alone — those are generated artifacts rather than caches, and regenerating them is slow (see above).

It exists because of a failure mode that is genuinely hard to recognise. Vite's dependency pre-bundling cache lives *inside* `node_modules/`, so it survives `git checkout`, `bun install`, and restarting the dev server. A long-lived local clone can therefore serve module output built from a commit you are no longer on, and nothing in the normal workflow invalidates it.

The symptom to recognise:

- A route **matches** — you get a blank page rather than the catch-all page — but its component never mounts.
- **No error in the browser console, and none in the dev server terminal.**
- `bun run test` passes, because Vitest does not use that cache.
- A fresh clone of the same commit works.

The tell was the disagreement between those first two facts: this was diagnosed under the vinxi/SolidStart serving layer, where route *scanning* read the filesystem directly and saw your checkout while module loading went through the cache and saw the older build. Routes are now an explicit table in `src/router.tsx` (see `CLAUDE.md`'s "Routing"), so that particular split no longer exists — but the cache and everything else about the failure do. When a page renders nothing with no error anywhere, suspect the cache before suspecting the code, and run `bun run clean` first.

It is also worth reaching for before trusting any local run of a suite that loads the real app — the browser E2E suite, and any future measurement harness, go through the same cache.
