# Groove - Development Guide

## Project Overview

Groove is a browser-based music production tool designed to make music creation accessible and intuitive. It features real-time collaboration, AI assistance, pattern-based sequencing, and a library of sounds and instruments.

## Tech Stack

### Core Framework
- **SolidJS 2** (`solid-js@2.0.0-rc.3`) - Reactive UI framework
  - Use SolidJS best practices: signals, stores, and effects
  - Store APIs (`createStore`, `reconcile`, `snapshot`, `storePath`) come from `solid-js` itself — there is no `solid-js/store` subpath
  - Control flow (`Show`, `For`, `Switch`, `Match`, `Loading`, `Errored`) and the `JSX` types come from **`@solidjs/web`**; `solid-js` no longer exports a `JSX` namespace, and there is no `solid-js/web`. (`@solidjs/web` re-exports the control-flow components from `solid-js`, so either import resolves to the same component — most of the repo names `@solidjs/web`.)
  - `Suspense` is `Loading` and `ErrorBoundary` is `Errored`; `Errored`'s fallback receives the error as an **accessor** (`(err, reset) => ... err().message`). See `src/app.tsx`
  - Use `createEffect(compute, apply)` for side effects and `createMemo` for derived values — see "Effects and Cleanup" below, and read it before writing one
  - Utilize Context providers for global state (see the `AuthProvider` pattern in `src/auth/AuthProvider.tsx`)
- **`@solidjs/vite-plugin`** - The serving layer, in **client start mode** (`solid({ start: true })` in `vite.config.ts`). It owns the dev server, the generated entries, and the build. There is no `@solidjs/start` release for Solid 2 and there is not meant to be one — Start is a mode of this plugin now, which is why the repo carries no `app.config.ts`, no `vinxi`, and no `src/entry-client.tsx`/`src/entry-server.tsx`
- **Vite 8** - Build tool and dev server (`vite.config.ts`, which pins port 3000 and documents the client-start-mode decision)

### Backend & Data
- **Firebase Authentication** - User authentication and session management
- **Firebase Firestore** - Real-time database for project storage and synchronization
  - There is no SolidJS/Firebase integration library in the stack; the repository layer owns its own subscriptions (`ProjectRepository.watchProject`)

### Audio
- **Tone.js** - Web Audio API library for audio synthesis and playback
  - Used by `ProjectAudioGraph` (the stable, ID-keyed graph) and `src/editor/useProjectAudio.ts` (the hook that wires one open project onto it) for audio playback and synthesis

### Development Tools
- **TypeScript** - Strict mode enabled
- **Bun** - Package manager and runtime
- **Biome** - Linting and code formatting
- **Vitest** - Testing framework with jsdom

## Project Structure

One line per directory. Each file says what it is for in a comment at its top; read that rather than a list here. The rules about what may import or own what are in "Architecture Patterns" below.

```
src/
├── access/         # Who may sign in during the alpha: allowlist, sign-in gate, admin repository (#854), QA account pool (#1055)
├── analytics/      # The typed event catalog and its transports
├── arrangement/    # The arrangement view, its canvas renderer, gestures and clipboard
├── assistant/      # The assistant gateway (#69, ADR 0006): protocol, provider boundary, history, telemetry, quota and spend guards; Firebase- and SDK-free
├── audio/          # Tone/Web Audio: runtime, project graph, instruments, transport, offline render
├── auth/           # AuthProvider and the Firebase auth wrapper
├── browser/        # Browser capability detection and messages
├── commands/       # Shared command, transaction and history kernel
├── components/     # App-level UI: landing page, dashboard, dialogs
├── controls/       # The shared control registry and marks
├── domain/         # Canonical schema-v1 domain model (authoritative)
├── editor/         # The project editor: session, audio wiring, panes and panels
├── export/         # Stem export: rendering, batching and archives
├── instrument/     # Instrument faceplate parts
├── library/        # Read side of the generated factory asset manifest
├── monitoring/     # Error reporting, scrubbing and replay privacy
├── persistence/    # Schema-v1 Firestore layout and repository boundary
├── projection/     # Read-only projections of a Project for audio, arrangement, summary, assistant
├── routes/         # Page modules `router.tsx` points at (not file-based routing)
├── selection/      # UI-only selection and focus state, never persisted
├── shared/         # Helpers production code and tests both use: ids, clock, scheduler, schema
├── shortcuts/      # The one keyboard-shortcut registry and its dispatch (see docs/shortcuts.md)
├── testing/        # Helpers only tests use
├── userData/       # What a user stores outside projects, and the usage cap (#282)
├── userLibrary/    # A producer's own packs: model, import, analysis, repository (#282)
└── *.ts, *.tsx, *.css  # App root, router, document shell, theme, composition roots, telemetry wiring
tests/
├── e2e/emulator/   # THE Playwright browser suite against the emulators; flows/ holds one spec per core flow
├── e2e/hosted/     # Post-deploy smoke test against the real Hosting URL
├── e2e/support/    # walkthrough.ts, the screenshot capture
└── emulator/       # Firebase Emulator suite (rules, etc.)
functions/          # Cloud Functions: usage triggers (#282), sign-in gate (#854), `assistantTurn` (#69); every package the bundle imports is in functions/package.json
scripts/            # Build, verify, library pipeline, access admin and walkthrough scripts
public/             # Static files: fixtures, robots.txt
site.config.mjs     # Public origin, titles and description: one place to change the domain
release.config.mjs  # Release stage and for-profit flag
```

## Task tracking and landing work

Work is tracked as **Linear issues** in team `GRV`, project **Groove** (`https://linear.app/ben2/project/groove-f835b9ea1a25`); an issue is `GRV-<n>`, and that identifier is how PRs, branches and comments name it. The code, the pull requests and the Actions stay in `trygroove/groove` on GitHub. The issue body is the spec: what to build or fix and how to tell it works. Its comments carry progress, decisions and blockers. Readiness is the issue's **blocking relations** ("blocked by" in Linear); dependency prose in a body is descriptive only. Read, comment on and move an issue with `node .github/scripts/linear.mjs` (`issue GRV-12`, `comment GRV-12 --body-file f`, `state GRV-12 Blocked`; it needs `LINEAR_API_KEY`), the one Linear client; [`docs/linear.md`](./docs/linear.md) explains the wiring and the setup. **`gh` in a Claude Code cloud session:** `gh api` REST calls work even though `gh auth status` says the token is invalid (ignore it). GraphQL is blocked there, so `gh pr create/list/view` fail; use `gh api repos/trygroove/groove/...` or the GitHub MCP tools instead. In Actions every `gh` command works. The old GitHub issues are an archive: nothing reads them. [`docs/prd.md`](./docs/prd.md) holds the product's principles, not its features; only the product owner edits it.

### The board

The board is the team's Linear board: a card's column is its workflow state, and moving it is what starts the automation. `.github/workflows/board.yml` polls Linear (`.github/scripts/board.mjs poll`) and acts on what it finds, started within seconds of a card moving by a Cloudflare Worker that Linear calls (`scripts/linear/relay/`, see [`docs/linear.md`](./docs/linear.md)), every 15 minutes by that Worker's cron as a backstop, and hourly by GitHub's schedule if the Worker is down; GitHub events move cards the other way at once. A card is in exactly one column, always.

| Column | Moved there by |
| --- | --- |
| Backlog | Creating an issue |
| Ready | The product owner, once the spec is agreed. **This starts `/ship`** in Actions, which moves the card on to In Progress within a minute, unless a blocker holds it (see below); `/ship` holding off for a conflicting PR |
| In Progress | `/ship` starting; a failed QA; the product owner sending it back; a merge-queue failure |
| Blocked | `/ship` stopping on an unclear issue or a failed run; QA failing twice |
| QA | The PR that `Completes` the card merging (QA'd on production); a PR labelled `deploy-preview` that `Closes` it opening (QA'd on its preview) |
| Ready For Review | A PR for the card touching a gated path (labelled `needs-approval`); the QA bot passing a preview |
| Approved | The product owner, to merge its gated PRs. The poll labels them `status:approved`, `merge.yml` queues them and the merge queue lands them |
| Done | The QA bot passing it on production; a PR that `Closes` it merging |

Milestones are project milestones on the Groove project (`M1: …`, `M2: …`). A bug always has one: a new bug with none gets a short Claude run that puts it on the milestone of the area it is in. A feature with no milestone is unscheduled. Milestones can be added, renamed and renumbered freely; nothing relies on their names. An issue labelled `needs-shaping` has open questions (listed in a comment on it) to settle in a shaping session before it can go to Ready; `human-input-required` marks one waiting on the product owner. A PR that changes `firestore.rules` or `storage.rules` gets no preview; like any gated PR, it moves its card to Ready For Review. The column names are a contract (`STATES` in `.github/scripts/linear.mjs`): renaming one breaks the poll.

**Avoiding merge pile-ups.** Ready is a queue: fill it as deep as you like. Each poll starts at most four builds, in Linear priority order (Urgent first, then the column's order), and skips any card with a blocker that has not merged yet (a blocker counts as merged once it reaches QA). So sequence work that would clash, the same files or the same module where both change behaviour, with blocking relations ("GRV-61 blocked by GRV-59"): the later card waits in Ready and starts by itself once the earlier one's PR merges. Two changes landing at once in one area is how merge conflicts start. `/ship` makes the same check when it starts: if an open PR is likely to conflict, it holds off, makes that PR's card a blocker, comments on the card naming the PRs it waits for, and puts it back in Ready, so it restarts on its own once they merge. Only when a blocker cannot hold it (the PR names no card) does it go back to Backlog, to be moved to Ready again by hand.

The QA bot ([`docs/qa-bot.md`](./docs/qa-bot.md) holds its instructions) follows every merged PR back to the card its body names and tests that card on production, as the QA account, once it is in QA and the PR that put it there has deployed; a card in any other column it ignores. On a pass it comments a summary on the card and moves it to Done; on a fail it comments the findings on the card starting with `@claude` (which starts a fix in a new PR) and moves it to In Progress, or to Blocked after the second failure. The rare open PR labelled `deploy-preview` it tests on the preview as well, before it merges: a pass moves the card to Ready For Review, a fail comments on the PR the same way. An agent working a card keeps it current the same way.

**Asking for something on a card.** A comment that mentions `@claude` on a Linear card starts a Claude run on it within a minute; the run replies "Picking this up" under the comment and keeps its progress there. (On a GitHub PR, `@claude` in a comment or review still starts `claude.yml` at once.) Comments the automation writes start with "**Picking this up**"; never start your own with those words.

**Sending a card back.** To ask for changes on a card whose PRs are open, comment the feedback on the card or a PR, then move the card to In Progress (not Ready, which starts a fresh build). The board runs a rework agent on the open PRs, which fixes them in place, replies to the feedback, and moves the card back to QA (or Ready For Review if there's no preview). It stands down if an `@claude` run is already on it, as after a failed QA. A card with no open PRs whose work is unfinished (no merged PR `Completes` or `Closes` it, as when a sequence stopped at a gated PR) can be sent back the same way: `/ship` continues it from its handoff.

### Shape, then ship

Every task runs in two phases:

1. **Shape (interactive).** The product owner and Claude work the issue out together in a session: questions, prototypes, design studies. It ends with the agreed spec written into the issue body. Ask as many questions as it takes here; this is the cheap place to be wrong.
2. **Ship (unattended).** **`/ship GRV-123`** (`.claude/skills/ship/`, running `.claude/workflows/solid-groove-ship.js`) takes the issue from spec to PRs that merge themselves once green, with no further questions. When an issue ships as several PRs, it opens them one at a time, each after the one before has merged. If one of them is gated, the run waits as long as it can and then stops, saying so on the issue; approving that PR and moving the issue to Ready again continues from what has landed. It works out which of three kinds of work the issue is and scales the process to it:

| Kind | What it is | Tests | Review |
| --- | --- | --- | --- |
| **Feature** | New capability: one PR, or a few in sequence | Unit/component tests, plus a core flow when the feature adds a new user journey | Adversarial review, up to two fix rounds |
| **Fix** | Something is wrong | A regression test that fails before the fix (keep the red output for the PR body) | None |
| **Polish** | A small enhancement or tweak | A unit test where the behaviour is testable | None |

Triage also picks the **model tier** the build, its fixes and the review run on, the cheapest that fits the issue's complexity and novelty: **Haiku** for a fix or polish the spec pins down in a file or two along an existing pattern, touching no contract; **Sonnet** by default; **Opus** for novel or risky work (a new module or pattern, a contract change, real-time audio, streaming, rules or server code, a multi-PR feature). A feature never builds on Haiku and a review never runs below Sonnet; a cheaper build that cannot finish is retried once a tier up. A `model:haiku`, `model:sonnet` or `model:opus` label on the card overrides triage, and each PR body says which tier built it.

Whether the issue says "bug" or "enhancement" does not matter. Behaviour that works as coded but is not what the product owner wants is still a change to make: never stop because something "is expected behaviour". Ship stops only when the issue is genuinely unclear (two reasonable readings would build materially different things) and comments the question on the issue.

Quality outside features is kept by periodic code-quality and architecture sweeps that open their own cleanup issues, not by reviewing every small change.

### Core flows

A **core flow** is one user journey that must work end to end, written in plain English in [`docs/core-flows.md`](./docs/core-flows.md) with a stable ID (`CF-001`, …) and reproduced by `tests/e2e/emulator/flows/<ID>.spec.ts`. Flows are for journeys worth guarding for the life of the product, not for every feature.

- A feature that adds such a journey gets its flow written by the agent shipping it, as its **own PR, landed first**: the register entry and the spec, marked `test.fixme`. The PR that completes the feature removes the `fixme` and makes it pass.
- An existing flow's assertions are not weakened to fit an implementation. If one has to change, the PR body says what changed and why.
- `bun run verify:core-flows` enforces one spec per registered flow and lists any flow still parked at `fixme`.

### Landing work

- **Open PRs ready for review, not as drafts.** The product owner is the only reviewer; a draft just hides finished work.
- **Always open the PR yourself.** Work that ends as a pushed branch with a "Create PR" link is lost: nobody clicks it. Every run that pushes a branch for a card, including an `@claude` run, opens its PR (`gh pr create`, or the GitHub MCP `create_pull_request`) before finishing, and checks it exists.
- **Title:** `Implement GRV-<n>: Title` for a feature or polish, `Fix GRV-<n>: Title` for a fix. The title says what the PR does (for a fix, what was broken). A sequence of PRs for one card says its position in the body ("2 of 3, follows #<prev PR>"), not the title. Branches are `claude/grv-<n>-<slug>`.
- **Body:** `Completes GRV-<n>` on the PR that completes the card, `Refs GRV-<n>` on earlier ones. The merge moves the card to QA, which is what tells the QA bot to test it on production; a pass moves it to Done, a fail back to In Progress. `Closes GRV-<n>` is only for a PR QA'd on its preview (labelled `deploy-preview`): its merge moves the card straight to Done. Then what changed; the commands run and their results. Follow `.github/pull_request_template.md`.
- **A new Google Cloud API goes in the body, with the command that enables it.** The deploy cannot turn an API on, so a PR that needs one the project does not use yet fails the deploy on `main` unless the product owner enables it first. A PR that brings one in says so under the template's **Cloud APIs** heading: each API, why it is required (the code that needs it and what that code does), and the `gcloud services enable <api> --project <project-id>` command to run before approving. The usual sources are a new kind of Cloud Function trigger (`onSchedule` needs `cloudscheduler.googleapis.com`, `onTaskDispatched` `cloudtasks.googleapis.com`, `onMessagePublished` `pubsub.googleapis.com`), a secret (`defineSecret`, `secretmanager.googleapis.com`) and a new Firebase or Google Cloud product. To check whether an API is new, look for an existing use of it in `functions/src/` and `firebase.json`; if you can't tell, list it.
- **Every PR targets `main`, and small is the preference.** One PR per issue is the default, and around 400 changed lines is the sign a change wants splitting: a preference, not a cap, so a bigger PR that is one coherent change is fine. An issue may ship as **several PRs in sequence**, each landing before the next opens: a catalog, schema or pure refactor change first and the feature built on it after; a core flow at `test.fixme` before its implementation. Keep the sequence as short as the dependencies allow; parts that do not depend on each other belong in separate issues. Each PR leaves `main` working on its own. Tests ship in the same PR as the code they cover. Never mix a behaviour change into a pure move.
- **No stacked PRs.** A PR is never based on another PR's branch, and nothing rebases or force-pushes a branch that has an open PR. The next PR in a sequence opens once the one before it has merged, with `main` merged into its branch first (`/ship` waits for that merge and does this itself). When `main` moves under an open PR so that it no longer merges cleanly, `.github/workflows/conflicts.yml` labels it `merge-conflict` and asks `@claude` to merge `main` into the branch; a PR that still merges cleanly is left alone, because the merge queue tests it on top of `main` anyway. A rejected push means someone else pushed the branch: `git pull` (a merge, not a rebase) and push again. Never use `gh stack` or another `gh` extension (they are not installed, and some need GraphQL that agent sessions cannot reach).
- **Screenshots: required whenever any UI changes** (markup, CSS, copy). Show the changed state, and the before state when that helps; usually one to five images, never a dump of every step, never none. Capture them with the helper in `tests/e2e/support/walkthrough.ts` from any emulator-suite spec (a flow spec, or a scratch `tests/e2e/emulator/<slug>.screens.spec.ts` run with `bun run screenshots -- <spec>`), then `bun run walkthrough:publish -- --issue GRV-<n>` pushes them to the `claude/walkthroughs` branch and prints the Markdown for the PR body. Images cannot be attached through the GitHub API, which is why they live on a branch. Keep each image URL under 150 characters (the agent environment wraps longer ones in backticks and they render broken), and after updating a body check every image returns `200`. A PR with no UI change says so.
- **QA is after the merge.** The app is a work in progress, and nothing is hidden behind feature flags yet: every merge deploys to production, and the QA bot tests the card there once the PR that completes it lands. So each PR must leave `main` working (the feature may be unfinished; nothing that worked before may break). A preview is optional: add `deploy-preview` to a PR only to see it before it merges. A preview runs against the **live production** backend with production's rules, so never label a PR that changes `firestore.rules` or `storage.rules`.
- **Merging:** `.github/workflows/merge.yml` queues every PR on its own once it opens or is pushed, unless it is a draft, is labelled `hold`, or touches a **gated path**: `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `firebase.json`, `src/domain/`, `src/persistence/`, `functions/`, `package.json`, `bun.lock`, `release.config.mjs`, `.github/`, `.claude/` or `scripts/linear/relay/` (the list is `GATED` in `.github/scripts/merge.mjs`). Those change stored data, access, server code, dependencies or the automation itself, which tests do not fully cover. A gated PR is labelled `needs-approval` and its card goes to Ready For Review; the product owner approves the whole card by moving it to Approved in Linear, or one PR by adding the `status:approved` label to it. Keep a gated change in its own PR, landed first, so the rest is not held up. The queue tests each PR on top of `main` and the PRs ahead of it, so `main` only receives green combinations. When a queue run fails, `.github/workflows/ci-failure.yml` comments the run on the PR with `@claude` and moves the card back to In Progress; the fix's push re-queues it. If `main` still goes red, the same workflow **stops the line**: every open PR leaves the queue and the board starts no new builds until `main` is green again, when both resume on their own; only a revert or a PR labelled `fixes-main` lands meanwhile. It re-runs the failed jobs once, so a flake goes green and nothing is reverted; a second failure reverts the PR that broke it through the queue, labels `hold` on that card's other open PRs (they were built on it; remove the label once it is safe to land them), and files a `Re-land #<pr>` issue in Linear. An agent never merges, never moves a card to Approved or adds `status:approved`, and never removes `needs-approval` or `hold`.
- **Contracts:** domain schema, command registry, parameter definitions, persistence layout, selection, audio projection and rendering projection are contracts. Changing one is fine when the task needs it, but update every contract test and consumer in the same change and say so in the PR body.
- Git history is the completion record; do not put a commit hash into a commit. Do not preserve compatibility with prototype project data (schema v1 is the first production schema).

### Definition of done

- The issue's spec is met, including the failure and empty states it touches. A deliberate deviation is stated in the PR body with its reason.
- `bun run typecheck`, `bun run test` and `bun run check` pass. Work that touches browser, Firebase, audio or export behaviour also runs that suite.
- New behaviour goes through shared commands and boundaries, not a feature-specific mutation path.
- **Analytics ships with the feature.** A new or changed user action emits its events through the typed catalog in `src/analytics` (extend the catalog in the same PR, at minimum a `feature_first_use` key), with a test that it fires once per action. No ad-hoc event strings.
- No event or error-report parameter carries a project, track, clip, section or asset name, assistant text, a user-entered string, an asset URL, or a token.
- UI changes carry screenshots; every PR is ready for review and leaves `main` working.
- No unrelated formatting, dependency, generated-file or refactor churn.


## Commands

All commands use Bun as the package manager and runtime:

```bash
# Development
bun run dev          # Start development server

# Build and production
bun run build        # Build for production
bun run start        # Start production server
bun run clean        # Delete build/dev caches and test output (see docs/testing.md)

# Code quality
bun run check        # Run Biome linting

# Testing
bun run test              # Unit + component tests, the five application projects (needs an audio output device — see Testing below)
bun run test:all          # Every project, including the slow library-pipeline one. What CI runs.
bun run test:library      # The sample-library build pipeline alone (scripts/)
bun run test:watch        # The five application projects, watch mode
bun run test:ui           # Unit + component tests, Vitest UI
bunx vitest run --project=audio   # One layer — see vitest.config.ts for the six projects
bun run verify:test-projects      # Every test file is owned by exactly one project
bun run test:emulator     # Firebase Emulator suite (Firestore rules, etc.)
bun run test:browser:emulator  # Browser E2E suite against a local Firestore/Auth emulator (Chromium, Chrome, Edge, Firefox)
bun run test:browser:emulator:chromium  # Chromium-only pre-flight for it (see "Which browsers run where" in docs/testing.md)
bun run test:browser:install  # One-time: download Playwright's browser binaries

# Core flows and PR screenshots
bun run verify:landing-static                # `/` is statically generated, and no other path carries its markup
bun run verify:core-flows                    # Every flow in docs/core-flows.md has exactly one spec, and vice versa
bun run screenshots -- <spec>                # Capture step() screenshots from any emulator-suite spec (e.g. a scratch *.screens.spec.ts)
bun run walkthrough:capture                  # Capture step() screenshots from the core-flow specs (emulator backend)
bun run walkthrough:publish -- --issue GRV-<n>   # Push the images and print the Markdown for the PR body
```

An environment that cannot reach `cdn.playwright.dev` — Claude Code on the web
included — can only install Chromium. Run the `:chromium` pre-flight there for
any change that touches the browser. Per push, CI runs only the emulator suite's
`@sanity` subset in Chromium (one pass through each major surface; tag a spec's
`test.describe` with `{ tag: "@sanity" }` to add it, sparingly). The full
emulator browser suite, in every browser, run once a day on `main` and on demand from the
Actions tab ("Run workflow" on CI); a failed daily pass opens a bug, and tests
that only passed on a retry open a flaky-tests bug. A green Chromium-only run is
not the PRD section 10 gating evidence and must not be reported as one.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local setup, the three backends the app can run against (mock, Firebase Emulator, real project), and the day-to-day loop; [`docs/testing.md`](./docs/testing.md) for what each suite covers, how CI gates on them, and the shared test helpers (`src/shared/id.ts`, `src/shared/clock.ts`, `src/testing/fixtures.ts`).

## Code Style Guidelines

### General Principles
- **Keep code tidy and modular**: Break out functions and components to keep them simple, clear, and easy to read
- **No long, complex blobs**: If a function or component is getting too long, split it into smaller pieces
- **Prefer third-party dependencies**: Use well-maintained libraries rather than implementing common functionality from scratch
- **Use TypeScript strictly**: The project has `strict: true` enabled

### SolidJS Best Practices

1. **State Management**
   - Use `createStore` (from `solid-js`) for complex nested state updates (see `src/editor/useEditorSession.ts`). `produce` is gone — mutating the draft **is** the setter's default behaviour: `setState((draft) => { draft.project = next; })`
   - Domain state changes only through the command layer (`src/commands`); a component never mutates a `Project` directly
   - Export setter functions rather than exposing setters directly
   - Keep stores focused on a single domain (auth, editor session, etc.)

2. **Context Providers**
   - Follow the pattern in `AuthProvider.tsx:18`
   - The context object **is** its own provider: `<AuthContext value={state}>`, not `<AuthContext.Provider value={state}>`
   - `createContext<T>()` with no default returns `T` from `useContext` and throws `ContextNotFoundError` when no provider is mounted, so there is no `as T` cast to write and no throw-wrapper hook to hand-roll
   - Always provide a typed hook for consuming context (e.g., `useAuth()`)

3. **Effects and Cleanup**
   - `createEffect` is split in two: `createEffect(compute, apply)`. **Only the compute half is tracked.** A reactive read moved into the apply half compiles, runs once, and then silently never re-runs — enumerate every reactive read an effect needs and keep all of them in the compute half
   - The apply half is where a write belongs: a signal or store write inside a tracking scope throws in dev, and the apply half is not a tracking scope
   - **Cleanup is the value the apply half returns**, not a nested `onCleanup`. `onCleanup` still exists and is still right at the top level of a component or hook body (see `src/editor/useEditorSession.ts`); what changed is that it no longer nests inside an effect
   - Example pattern:
   ```typescript
   // A subscription with no reactive dependencies: compute returns a constant,
   // the apply half opens the subscription and returns its teardown.
   createEffect(
     () => undefined,
     () => {
       const unsubscribe = service.subscribe(...);
       return () => unsubscribe();
     },
   );

   // A subscription keyed on something reactive: that key is read in compute.
   createEffect(
     () => props.id(),
     (id) => {
       const unsubscribe = service.subscribe(id, ...);
       return () => unsubscribe();
     },
   );
   ```
   - Worked examples: `src/auth/AuthProvider.tsx` (both shapes), `src/app.tsx` (`SurfaceTracker`, two reads in one compute), `src/components/TelemetryDisclosure.tsx` (a write that is only legal in the apply half)
   - `onMount` is `onSettled`, and it **returns** its cleanup rather than nesting `onCleanup` (see `src/app.tsx`)

4. **Component Structure**
   - Keep components focused on a single responsibility
   - Extract complex logic into separate functions or composables
   - Use functional components with props typing

### Firebase Integration

1. **Authentication**
   - Use AuthProvider for app-wide auth state
   - Access via `useAuth()` hook
   - AuthProvider automatically redirects unauthenticated users to home

2. **Firestore Data Access**
   - All Firestore operations go through the schema-v1 `ProjectRepository` boundary (`src/persistence`), obtained via `getProjectRepository()` (`src/projectRepositoryClient.ts`) — never call `firebase/firestore` directly outside `src/persistence/firestoreProjectRepository.ts`
   - The one other module allowed to import `firebase/firestore`, and the only one allowed to import `firebase/storage`, is `src/userLibrary/firebaseUserLibraryRepository.ts`: the personal library's packs and audio (#282), behind `UserLibraryRepository` and obtained via `getUserLibraryRepository()`. It never hands out a download URL; audio is read back as the signed-in user with `readAudio`
   - `src/access/firestoreAccessRepository.ts` may import `firebase/firestore` too: the alpha allowlist and its refused sign-ins (#854), behind `AccessRepository` and obtained via `getAccessRepository()` (`src/accessRepositoryClient.ts`). Only an `admin: true` claim gets past `firestore.rules` there
   - Use `ProjectRepository.watchProject` for the metadata tier's live revision; `EditorSession` wires it into `ProjectAutosave`
   - Security rules enforce owner-based access (see firestore.rules)

3. **Data Flow Pattern**
   ```
   Component → typed command → CommandHistory.execute() (EditorSession) → new Project revision
     → ProjectAutosave queues the changed tier → ProjectRepository → Firestore
   Firestore → ProjectRepository.watchProject → ProjectAutosave.applyRemote() → Component reactively updates
   ```

### Path Aliases
- Use `~/*` to reference files from `src/` directory (configured in tsconfig.json:20)
- Example: `import { useAuth } from "~/auth/AuthProvider"`

### TypeScript
- Define domain types in `src/domain` alongside their runtime schema
- Use discriminated unions for variant types (see the domain Instrument and ClipContent types)
- Leverage `Partial<T>` for update operations

## Architecture Patterns

### Canonical domain model (`src/domain`)
- `src/domain` is the authoritative schema-v1 contract. Its types, Zod schemas, invariants, and tests replace any separate domain-model document.
- It has no Firebase, Tone.js, or SolidJS imports. Persistence, commands, audio, and rendering consume it from outside; audio nodes and Firestore `Timestamp`s never enter project state.
- Persistent relationships use prefixed IDs from `createIdFactory()` (`createSeededIdFactory()` in tests), never array positions.
- Musical time is integer ticks at 192 PPQ. Seconds, bars/beats/16ths, and pixels are derived through `src/domain/time.ts`.
- A user-controlled numeric value declares its range, unit, default, clamping policy, and automation capability once in `src/domain/parameters.ts`; UI, validation, audio, and assistant tools read that definition instead of repeating literals.
- **Asset identity is pack-qualified**. A `Pack` (`pak_` ID, name, `major.minor.patch` version, publisher, kind, description, one rights position) describes *library* content and is never stored inside a project; an `Asset` names the `packId` and `packVersion` it resolved from. A project's `metadata.packDependencies` is the derived list of those packs — `derivePackDependencies(song)` computes it, `executeTransaction` recomputes it once per transaction, `saveSong` writes it to the metadata tier, and `parseProject` rejects a list that has drifted from the song's assets in either direction. Unresolvable audio is a reported state from `resolvePackAvailability`, naming the affected tracks and clips, never a dangling reference or a substituted version. It resolves per *asset*, not per version string: the caller supplies the pack versions it holds along with the asset IDs each contains, so a pack that gained sounds still resolves, a pack held at no version is a missing pack, and a deleted sound is a missing asset. See [`docs/persistence.md`](./docs/persistence.md#packs-and-pack-qualified-assets).
- `parseProject` is the only way to obtain a `Project`. It either returns a fully valid project or a list of issues, and never partially repairs input.
- Changing this contract is its own task (a dedicated issue), not incidental work inside a feature.

### Schema-v1 persistence (`src/persistence`)
- The three-tier Firestore layout is a contract: `projects/{projectId}` metadata, `projects/{projectId}/song/current`, `projects/{projectId}/clips/{clipId}`, and `projects/{projectId}/arrangement/{trackId}` chunks when the song document exceeds its budget. See [`docs/persistence.md`](./docs/persistence.md).
- `src/persistence/documents.ts` owns every collection path and document body. No other module builds a Firestore path or document for a project.
- Every write is revision-checked and every tier is written independently: a note edit writes one clip document, never song structure.
- `ProjectRepository` has an in-memory and a Firestore implementation, and both run the same contract suite. Only `firestoreProjectRepository.ts` imports `firebase/firestore`, so it is not re-exported from the directory barrel.
- Autosave (`autosave.ts`) coalesces rapid edits, exposes save state, keeps a failed write queued for retry, and ignores remote echoes at or below the local revision.

### Shared command layer (`src/commands`)
- Every project mutation — pointer, keyboard, or assistant — is a registered command. Components never write to project state; they build a typed command and hand it to `CommandHistory`.
- A command declares a versioned type, a Zod payload schema, a pure `apply`, a generated `invert`, and a one-line `summarize`. Payloads carry explicit IDs for anything they create, so replay, redo, and assistant previews reproduce the same project.
- `executeTransaction` is the atomic unit: commands apply to a working copy, the result is checked against every domain invariant, and any failure returns the original project object untouched. One committed transaction produces exactly one revision and one history entry.
- Continuous gestures use `history.beginGesture()`; every step applies immediately but the whole drag commits as one entry and one revision.
- Undo/redo is session-local, bounded, and replays inverse commands rather than project snapshots. Only an explicit `replaceProject` clears it — a save acknowledgement or remote echo must never touch it.
- Like `src/domain`, this layer imports no Firebase, Tone, or Solid. Adding or changing a command is a contract change; see the registry test's pinned command list.

### Audio engine (`src/audio`)
- `AudioRuntime` is the single application-scoped owner of the real-time Tone/Web Audio context, transport, buffer cache, and resource registry. It is the only place production code may create, install, resume, suspend, replace, or close that context — obtain it via `getAudioRuntime()`, never construct one directly.
- `ProjectAudioGraph` reconciles a read-only `AudioSongProjection` (from `src/projection/audioProjection.ts`) into a stable graph keyed by track, instrument, device, return, and asset IDs. Passing back the exact projection object the audio projection handed out previously is a complete no-op; an edit to one track, return, or placement only touches that entity's own subgraph.
- `TrackAudioGraph`/`ReturnAudioGraph`/`MasterAudioGraph` each own one channel strip (`Tone.PanVol`/`Tone.Volume`) plus a `DeviceChain`. `DeviceChain` reconciles an ordered `Device[]` by id: only added/removed devices create or dispose a node, and reordering relinks connections without recreating anything. Schema v1 has no concrete processors yet (Alpha Milestone 1 authors them); an unregistered `device.type` gets an inert passthrough node so topology is provable ahead of real DSP.
- `InstrumentGraph.ts` builds the sampler/synth/drum-machine node for a track's `Instrument`. A track only replaces its instrument node when `kind` changes; an asset swap, a drum-pad added/removed, or a generic parameter edit calls the existing node's `update()` instead. The module itself is just the `kind` dispatcher and the public surface (`InstrumentNode`, `InstrumentGraphContext`, `InstrumentNodeFactory`, `createInstrumentNode`, `playOneShot`) — consumers import it and nothing else. Each instrument's implementation lives in its own module under `src/audio/instruments/`, over the shared types in `instruments/types.ts` and the asset-subscription helpers in `instruments/assetVoice.ts`.
- `AudioBufferCache` decodes and caches asset buffers keyed by asset ID and content fingerprint, with reference-counted eviction and generation-tracked cancellation so a stale decode can never reconnect or overwrite a newer one. It never imports Tone itself — `toneBufferLoader.ts` is the one production loader that does, which keeps the cache's generation/refcount bookkeeping testable without any Web Audio globals.
- `Transport.ts` owns the session-scoped playhead: play/pause/stop/seek/continue, the 40-240 BPM clamp, a bar-aligned loop range, and the metronome. It is written against an injectable `TransportEngine` rather than `Tone.getTransport()`, and it never schedules the arrangement — a tempo change is mirrored onto the transport, not applied by rebuilding nodes. Tempo lives in the song and is written only by a `parameter.set` command; this layer mirrors it. `underrun.ts` counts late dispatches and reports them *sampled* as `audio_underrun`; it compares an event's intended time against `ProjectAudioGraph.audioClockNow()` (the context's true `currentTime`), never `Tone.now()`, which is `currentTime + lookAhead` and would score healthy playback as a continuous stream of drops.
- `audioLoopPlayer.ts` plays one scheduled audio-loop event. A loop declares the tempo it was authored at, and it follows the song tempo by *time-stretching*, not resampling: `Tone.GrainPlayer` walks the buffer at `tempo / sourceTempo` while each grain sounds at its native rate, so the loop's pitch stays where it was recorded. At an unstretched rate of 1 it falls back to a plain `Tone.Player`, so a loop at its own tempo pays no granular cost at all. `audioLoopOffsetSeconds` is a position in the *buffer's* timeline and `audioLoopDurationSeconds` a span of the *song's* — the two only coincide at rate 1, and mixing them up is what silently truncates or overruns a stretched loop.
- `scheduling.ts` expands a placement's clip content into absolute-tick events (looping and clip trimming included) as a pure function of the audio projection; `ProjectAudioGraph` schedules those against `Tone.Transport` (or an injected `AudioTransport` in tests) with an owner-tracked handle per event, never an anonymous global callback.
- Every constructed Tone/Web Audio resource is registered with the owning `AudioProjectScope` (`AudioRuntime.openProjectScope`) so disposal is idempotent and instrumented — components and domain stores request graph operations but never receive mutable audio nodes.
- [`docs/audio-graphs.html`](./docs/audio-graphs.html) draws every instrument, device and strip graph as nodes and connections. It is hand-kept, not generated: a change to how `src/audio` builds or wires nodes updates the matching entry in its `GRAPHS` list in the same PR (the comment at the top of the page explains the format).
- `src/editor/useProjectAudio.ts` is the one place a component wires a `Project` onto `ProjectAudioGraph`: it rebuilds the `AudioSongProjection` (passing the previous one through, so an unrelated edit reuses unchanged entries) on every project change, and its `play()` is the allowed user gesture that resumes the shared `AudioRuntime` context. The prototype `SongPlayer`/`ToneInstrument`/`AudioProvider.tsx` playback path this superseded was removed by `FND-009`; do not reintroduce a component-owned Tone lifecycle.

### Shortcut registry (`src/shortcuts`)
- `src/shortcuts/registry.ts` is the only place a key combination is written down ([`docs/shortcuts.md`](./docs/shortcuts.md) is its human copy). Event handling, tooltips, menu labels, the `?` guide, the `shortcut_used` analytics `action_id` set, and [`docs/shortcuts.md`](./docs/shortcuts.md) are all derived from it; a component never compares `event.key` itself and never adds its own `keydown` listener — modals included, which register `view.close_surface` for `Escape` (see `src/components/ConfirmDialog.tsx`) rather than owning a per-modal listener.
- An entry declares action ID, per-platform keys, valid contexts, guide group, and whether it follows or intentionally differs from Ableton Live. Enabled state is not in the registry — the surface that owns the action supplies a handler with an optional `isEnabled()`, and an action with no handler simply does not fire.
- `ShortcutController` is framework-free and owns every dispatch rule: `global` is always active, `dialog` suppresses every other context, typing targets keep their keys (only `Escape` is marked `textEntry: "allowed"`), auto-repeat is ignored unless the mapping opts in, and a disabled or unhandled action leaves the browser default alone. `useShortcuts` is the thin Solid adapter that installs it on the window.
- Matching reads `KeyboardEvent.key`, never `code`, and ignores the Shift modifier for punctuation, so `?` and `+` work on any keyboard layout.
- `ShortcutController` logs `shortcut_used` with the matched entry's own `action_id`; handlers never log analytics. Adding a mapping means adding its ID to `SHORTCUT_ACTION_IDS` in both the registry and `src/analytics/catalog.ts`, or `catalog.test.ts` fails.
- Adding a shortcut also means updating `docs/shortcuts.md` — `src/shortcuts/docs.test.ts` fails if the two drift.

### The palette (`src/theme.css`)
- **Read [`docs/design.md`](./docs/design.md) before changing how anything looks**: square corners, a monochrome palette with colour kept for meaning, clearly organised sections, and one shared set of parts.
- The faceplate design the instrument, device and mixer surfaces follow (#447) is [`docs/faceplate-system.html`](./docs/faceplate-system.html), a self-contained page that plays. It is the reference for layout, parts and states; `src/theme.css` stays the authority for colour.
- The Post-Alpha instruments (synth #940, wavetable #944, FM #945, drum synth #989, sampler #122/#943) follow [`docs/instrument-faceplates.html`](./docs/instrument-faceplates.html), a playable study in the faceplate system: every section stacks heading, well, switch and faders so each row lines up across the instrument; sections share one set of names and follow the signal (oscillators, filter, voice, amp envelope, filter or mod envelope, LFO); the header carries Randomize, the preset picker and Audition on its right. Its sounds and presets are stand-ins; its layout, parts and names are the reference.
- The library modal (#449) follows [`docs/library-browser.html`](./docs/library-browser.html), a playable walkthrough of finding, filtering, similar sounds, browsing packs, the library-only keys and inserting. Its data and synthesized sounds are stand-ins; its layout, parts and flow are the reference.
- The Export dialog (#724) follows the **Release** tab of [`docs/export-dialog.html`](./docs/export-dialog.html), a clickable prototype: the song leads, the stems track list is the mini-arrangement's name column (click, ⇧-click range, ⌘-click pick), stems over 2 GiB download as batched ZIPs, and a finished export celebrates in the tracks' own colours. Its data and render timings are stand-ins; its layout, parts, copy and states are the reference. The other two tabs are the alternatives it was chosen over.
- `src/theme.css` is the only place a colour is written down. It holds custom properties and nothing else, so a static page (`docs/architecture.html`) can link it without dragging the app's base styles along. `src/app.css` `@import`s it, and Vite inlines that at build time.
- **The interface is literally monochrome: every token is a neutral grey with R, G and B equal.** No tinted greys, no coloured accent, no coloured status. Black and white are the anchors; the ramp between them (`--mono-00` … `--mono-100`) is nine steps, each with exactly one job, and mid-greys are what it spends least.
- **State is brightness, not hue.** Selected, focused, active and playing are the brightest thing in their neighbourhood — usually a white fill with `--color-on-accent` (black) on it. `--color-accent-dim` and `--color-accent-deep` are the steps below for a fill under the pointer and for material that is present but not chosen.
- **The one exception is the selected track, which is black** (#447, a product-owner decision): the track the editor is showing sinks to `--color-background` wherever tracks are listed, the arrangement's header, the instrument rail, the mixer strip, and the selected drum pad's row with them, so the selection reads as a hole in the panel while pressed toggles and chosen options stay white.
- Status is monochrome too, so an error signals through emphasis and framing (`--color-danger-wash`/`-edge`) and through its wording — not through being red. A destructive action is a white fill with black on it, the loudest control on screen. If a pairing puts a bright fill under bright text, that is a bug: check the `color` beside every `background`.
- **The level meters' clip state is the one status in colour** (#447): a meter fills `--signal-ok` (green) while its track peaks under 0 dBFS and `--signal-clip` (red) for a moment after a peak goes over (`src/editor/trackLevels.ts`). Its bar is the RMS; only peaks can say a track clipped. The pair is a product-owner decision, only `LevelMeter.css` may read it, and `theme.test.ts` pins both halves.
- **A track's own colour is the other hue in the product, and it is not theme** — it is persisted domain data (`TRACK_COLORS` in `src/domain/factories.ts`), so changing it is a schema change. Against a colourless interface it is unmissable, which is the point.
- Style against a **semantic alias** (`--color-background-secondary`, `--color-text`, `--color-accent`), not a ramp step. The ramp is the vocabulary; only the aliases survive a re-theme. Never introduce a near-duplicate of a step that already exists, and never a local alias for a token that already says the same thing.
- `src/theme.test.ts` enforces all of it: a colour literal in any other stylesheet, a token read but never defined, a token whose channels are not all equal, a tint borrowing anything but black or white, a tenth ramp step, or an arrangement-canvas fallback that has drifted from the theme each fail there.
- A canvas cannot read a custom property, so `src/arrangement/canvasRenderer.ts` resolves the tokens off the document once and caches them; its literals are fallbacks for a context with no stylesheet (jsdom), pinned to the theme by that test.

### Service Layer
- Create service modules for external integrations (authService, dataService)
- Services handle all direct Firebase API calls
- Services provide clean, typed interfaces to the rest of the app

### Real-time Synchronization
- Use Firestore's `onSnapshot` for real-time updates
- Subscriptions are set up in the apply half of a `createEffect`, and their teardown is what that half returns
- Store updates mutate the draft the setter hands them; `produce` is gone, and draft mutation is the default

### Routing
- **There is no file-based routing.** `<FileRoutes />` came from `@solidjs/start/router`, and SolidStart has no Solid 2 release. Router 2 does ship a `fileRoutes()` adapter in `@solidjs/router/fs`, but it reads a `virtual:file-routes` manifest that `@solidjs/vite-plugin` does not emit, so there is nothing for it to consume
- Routes are an explicit table in `src/router.tsx`: a path and a `lazy()` page module per entry. Every page stays `lazy` — **except `/`**, which is eager because it is prerendered into the shell and its stylesheet has to be in the entry graph for that markup to paint styled (ADR 0008)
- Page modules live in `src/routes/`, but their filenames are only names — the `[param]`/`[...404]` spelling is gone, because nothing reads it. The patterns live in the table
- Use `useParams()` from `@solidjs/router` to read route parameters. Router 2 types them as `string | undefined`; narrow with `Show` rather than asserting (see `src/routes/projects/Project.tsx`)

## Testing

- Test files use `.test.ts` or `.test.tsx` extension
- Vitest configured with jsdom for DOM testing
- Use `@solidjs/testing-library` for component tests
- Use `@testing-library/jest-dom` for DOM assertions
- Beyond unit/component tests, the project has a Firebase Emulator suite (`tests/emulator/`, `bun run test:emulator`) and a Playwright browser E2E suite against a local Firestore/Auth emulator (`tests/e2e/emulator/`, `bun run test:browser:emulator`) — see [`docs/testing.md`](./docs/testing.md) for what each covers and how CI gates on them. The in-memory mock backend (`bun run dev:mock`) is a development backend only; no browser suite runs against it
- Use `src/shared/id.ts`'s `createId`/`createSeededIdFactory` for entity IDs and `src/shared/clock.ts`'s `Clock` for anything that needs the current time, rather than calling `nanoid()`/`Date.now()` directly, so tests can be deterministic
- Use `src/testing/fixtures.ts`'s builders (`buildProject`, `buildTrack`, ...) instead of hand-writing fixture literals in new tests

### `bun run test` needs an audio output device

Importing `tone` creates a real global `AudioContext`, and `node-web-audio-api`'s `cpal` backend refuses to create one on a host with no default output device (containers, CI runners, headless VMs), so any suite that reaches Tone fails at import time with `InvalidStateError: cpal backend error during default_output_config: DeviceUnavailable`.

That is an environment problem, not a test bug — **do not "fix" it by mocking Tone, skipping the file, or editing `src/audio/testAudioContext.ts`.** Set up a null ALSA device instead; [`CONTRIBUTING.md`](./CONTRIBUTING.md#a-null-alsa-device-on-machines-with-no-audio-hardware) has the exact steps.

**It applies to `bun run test` only — not the browser suites.** A real browser constructs a context regardless: Firefox reports `state="suspended"` on a runner with no `/dev/snd` at all. So if a *browser* test fails around audio, a null ALSA device will not help and its absence is not the cause — this exact wrong turn has already cost a CI round. See [`docs/testing.md`](./docs/testing.md#playback-is-asserted-in-chromium-only--a-known-tracked-gap), and `LOOP-003` (#43) for the product-side gap behind it.

## Important Configuration Notes

1. **The app runs client-side only** - `solid({ start: true })` with no `ssr` in `vite.config.ts` is the plugin's **client start mode**. `vite build` emits a static `dist/client` whose `index.html` is the shell prerendered once through the built handler, and the client `render()`s (never hydrates) into it. The app itself never renders on the server, which is the PRD's client-only decision unchanged.

   That shell is **not empty**: `src/Document.tsx` renders the landing page's markup and metadata into it, so `/` is indexable, unfurls, and paints with JavaScript disabled (ADR 0008). Only the document goes through the SSR transforms — the app does not. Because the generated entry renders `<Document />` with no request, the shell cannot be path-aware, so `scripts/emit-app-shell.mjs` writes a stripped `app.html` after the build and `firebase.json` serves `/` from `index.html` and every other path from `app.html`; the dev server and `vite preview` serve one shell and an inline script removes the markup during parse. `bun run verify:landing-static` gates both halves. A landing-only tag added to the document **must** carry `data-landing="true"` or it ships on every deep link
2. **Module system** - Using ESNext with bundler resolution
3. **JSX** - Preserved with `@solidjs/web` as the import source (`tsconfig.json`'s `jsxImportSource`)
4. **Strict TypeScript** - All strict checks enabled
5. **Package Management** - This project uses Bun as the package manager
   - **NEVER commit package-lock.json** - This file is auto-generated by npm and conflicts with Bun's package management
   - Use `bun install` for installing dependencies, not `npm install`
   - package-lock.json is in .gitignore and should remain there

## Common Tasks

### Adding a new route
1. Create the page module in `src/routes/`, with the component as its default export
2. Add its path to the `routes` table in `src/router.tsx`, wrapping the import in `lazy()` so it stays its own chunk. The filename does not define the route — the table does
3. It is served the `app.html` shell, not the prerendered landing document, so it renders entirely on the client

### Adding a new data model
1. Define the entity's shape and Zod schema in `src/domain/entities.ts`, and add any invariants it needs to `src/domain/parse.ts`
2. Add a factory in `src/domain/factories.ts` and cover it in `src/domain/fixtures.ts` if other tests will need it
3. Add or extend the commands that create/mutate it in `src/commands/definitions/`, registered in `src/commands/registry.ts`
4. Extend `src/persistence/documents.ts` if it changes what a Firestore document stores

### Adding a new component
1. Create in appropriate directory under `src/components/`
2. Keep focused on single responsibility
3. Extract complex logic to separate functions
4. Use TypeScript for props

### Working with audio
1. Use `useProjectAudio()` (`src/editor/useProjectAudio.ts`) to wire a project onto playback from a component
2. All Tone.js code should be in `src/audio/`
3. Keep audio logic separate from UI components

### Referencing a factory sound
1. Never write an asset name, storage path, duration, sample rate, or channel count into `src/` — those are the library's facts, and `CNT-001` removed the last hand-maintained copy of them
2. Ask `src/library/factoryLibrary.ts` (`factoryLibraryEntry`, `createFactoryAsset`) instead; it reads `factoryLibrary.generated.ts`, which `bun run library:emit-runtime` produces from the same builders that emit the delivered pack manifests
3. To ship a different starter sound, change `RUNTIME_SELECTION` in `scripts/starter-library/runtime.mjs` and re-run the command — the committed module is drift-checked by `scripts/starter-library/runtime.test.mjs`
4. Browsing the rest of the library fetches the pack index and then a pack manifest (sample-library section 12); it is not bundled
