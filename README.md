# Groove

So many people want to make music, but learning music production is hard. Let’s make it easier.

The music production tool of the future:

* Is easy to use, with a simple, intuitive interface
* Runs in a browser so you can get started quickly
* Tightly integrates AI, like having your favourite producer right there next to you
* Generates new ideas that you can build on
* Has a library of sounds and other elements
* Is collaborative, so you can work on projects with friends

Let's build it!

Try it at **[trygroove.app](https://trygroove.app)**.

## Documentation

| Document | What it covers |
| --- | --- |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Local development: setup, running against mock/emulator/real backends, and the pre-PR checks |
| [`CLAUDE.md`](./CLAUDE.md) | Stack, project structure, commands, and code style |
| [`docs/prd.md`](./docs/prd.md) | Product principles — vision, target user, goals and non-goals, sample licensing, and privacy. Not a feature specification |
| [`docs/core-flows.md`](./docs/core-flows.md) | The user journeys that must work end to end, each with a Playwright spec |
| [Linear board](https://linear.app/ben2/project/groove-f835b9ea1a25) | What to build: scope and acceptance criteria, one issue per task (team `GRV`). `CLAUDE.md` describes how work is tracked and landed; [`docs/linear.md`](./docs/linear.md) how the board drives the automation |
| [`docs/sample-library.md`](./docs/sample-library.md) | Sound library plan, licensing policy, and the shipped starter library |
| [`docs/testing.md`](./docs/testing.md) | Which test suite to run, and how |

## Getting started

```sh
bun install
cp .env.example .env
bun run dev:mock
```

`bun run dev:mock` runs against in-memory mock services and needs no Firebase project at all; `bun run dev:emulator` runs against a local Firebase Emulator (started with `bun run firebase:emulator`) when you need real persistence. [`CONTRIBUTING.md`](./CONTRIBUTING.md) covers both, and the real-project setup, along with the day-to-day development loop.

## Deployment

The private alpha has exactly one hosted environment — the **production** Firebase project — deployed to Firebase Hosting at [trygroove.app](https://trygroove.app) from CI on every merge to `main`, never from a developer machine. `bun run deploy` is the one documented command (it builds, scans the build for secrets, then ships Hosting, Firestore rules/indexes, and Storage rules together so a failing rules step fails the whole deploy); `.github/workflows/ci.yml`'s `deploy` job runs it automatically and follows it with a post-deploy smoke test against the real hosted URL. See [`docs/testing.md`](./docs/testing.md#deploy) for the full pipeline, the CI secrets/variables it needs, rollback, and how to get a local build talking to the right project.

A pull request labelled `deploy-preview` is also published to its own Firebase Hosting **preview channel** (`.github/workflows/preview.yml`) — an expiring URL inside the same production project, so it runs against the live Firestore, Auth, and Storage. It is opt-in per PR, it never deploys security rules, and it reports no analytics or errors; see [`docs/testing.md`](./docs/testing.md#per-pr-preview-deploys) for what that shares with production and what it does not.

The `deploy` job runs on merges to `main` and reads its credentials from the `prod` GitHub environment. `OPS-001` ([issue #68](https://github.com/trygroove/groove/issues/68)) verified deploy, rollback, analytics, and error monitoring against the hosted environment on 2026-08-05 and 2026-08-06, and gate `G4.5: Hosted environment verified` is open. Two console-inspection checks are deferred to post-alpha by decision (`DEC-012`). See [`docs/testing.md`](./docs/testing.md#what-has-been-verified-against-the-hosted-environment) for what was actually observed and what was deferred.

## Sounds

The app ships a starter library of 200 one-shots — drums, bass, tonal material, textures, and transitions — synthesized from code rather than downloaded, so it is reproducible in CI and unambiguous to redistribute. Alongside them are bar-aligned loops with verified BPM and seams, drum-kit and multisample-instrument presets, and derived masters, all produced by the same pipeline. There is also an acquisition path for CC0 content from vetted sources, where each file is individually selected, checksum-pinned, and reviewed.

Content is organized into **packs** — named, versioned collections such as "Core Electronic Drums" or "Foundation Bass" that a user browses and a project depends on. The synthesized 200 ship as five packs, one per family; [`docs/sample-library.md`](./docs/sample-library.md) section 5.1 defines the model and section 15.8 covers the pack list and delivery layout.

```sh
bun run library                     # print the whole workflow and what's on disk
bun run library:build               # render + merge the library and its manifest
bun run library:audition            # listen to it at http://127.0.0.1:4180
bun run library:validate            # build and validate without writing (run after changing the library)
bun run library:emit-runtime        # refresh the manifest the app itself resolves against
bun run library:upload              # publish to Cloud Storage
```

The assets the application ships with — the sound a new project starts from —
come from `src/library/factoryLibrary.generated.ts`, emitted by
`library:emit-runtime` from the same pipeline. Nothing in `src/` states an
asset's name, path, or audio metadata by hand.

Start with `bun run library` — it prints the ordered steps and reports what has
been built, pinned, and ingested so far. Always audition before uploading: the
validator checks that a sound is *well-formed*, only your ears check that it is
*right*.

See [`docs/sample-library.md`](./docs/sample-library.md) section 15 for what it contains and how it is delivered, and [`docs/licenses/starter-library-v1.md`](./docs/licenses/starter-library-v1.md) for its rights position.
