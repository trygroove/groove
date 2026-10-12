# Runbook: provisioning the hosted alpha

Everything `FND-001b` and `FND-001c` built is inert until a real Firebase project
and a real Sentry project exist. Neither task provisions an account or holds a
credential — deliberately — so the pipeline ships, verifies nothing, and no-ops.
This runbook is the manual half: it takes you from no accounts to a deployed,
observable alpha with the deferred acceptance criteria actually closed.

Run it once. Record the outcome on [issue #68 (`OPS-001`)](https://github.com/trygroove/groove/issues/68) as you go.

**When to run this.** This runbook is the body of task `OPS-001` ([issue #68](https://github.com/trygroove/groove/issues/68)), scheduled immediately **after Alpha Milestone 2** (PRD section 12, "After Alpha Milestone 2"). It was originally expected to run during Alpha Milestone 0, alongside `FND-001b` and `FND-001c`; that was rescheduled so one operator pass verifies deploy, rollback, analytics, and monitoring against the whole Alpha Milestone 0-2 feature set at once, rather than re-verifying after every milestone. The file is named for Alpha Milestone 0 because that is where the code it verifies was built, not when it runs.

Nothing here is optional or downgraded by the move — the acceptance criteria are unchanged, and the `HARD-005` cohort cannot be invited until this runbook has been executed. What changed is only when.

| Field | Value |
| --- | --- |
| Owner | Whoever holds the Firebase and Sentry accounts (not an implementation agent) |
| Frequency | Once, then only for the rollback drill in part 6 |
| Backlog task | `OPS-001` — Hosted environment verification and rollback drill |
| When | After Alpha Milestone 2, at the `REL-001` gate |
| Closes | Gate **G4.5: Hosted environment verified** |
| Related | [PRD 10 Security and privacy](../prd.md#10-non-functional-requirements), [ADR 0001](../adr/0001-sentry-for-error-monitoring.md), [`docs/testing.md`](../testing.md#deploy) |

## Before you start

- [ ] The `FND-001b` and `FND-001c` branches are merged to `main`. Until then
      `.github/workflows/ci.yml`, `firebase.json`'s hosting/storage config,
      `bun run deploy`, and `scripts/verify-no-secrets-in-bundle.mjs` are not on
      `main` and nothing below has anything to run.
- [ ] You have owner-level access to create a Google Cloud / Firebase project and
      a Sentry organization, and admin access to `trygroove/groove`'s
      Actions settings.
- [ ] `firebase-tools` is available locally (`bunx firebase --version`) for parts
      1 and 6. Parts 3–5 need only a browser.

A note on ordering: the deploy pipeline draws every value it needs from the
`prod` GitHub *environment*, which you create in part 3. Nothing deploys until
that environment exists and holds them, so parts 1 and 2 are safe to do in any
order and at any pace — merges to `main` keep passing, with `deploy` failing
fast on missing credentials rather than shipping anything.

## Part 1 — the Firebase project

The alpha has exactly one hosted environment, and it is production (PRD section
16). There is no staging project to rehearse against; that is the decision, not
an omission.

- [ ] **Create the project.** Firebase console → Add project. The project ID
      becomes the Hosting subdomain (`https://<project-id>.web.app`) and the
      value of `FIREBASE_PROJECT_ID` everywhere below. It is not sensitive.
      That subdomain keeps serving after a custom domain is connected; the
      alpha's public origin is `https://trygroove.app` (`SITE_ORIGIN` in
      `site.config.mjs`), and that is what the smoke gate targets.
- [ ] **Enable Google Analytics** during creation, or link it afterwards under
      Project Settings → Integrations. This is what produces the GA4 property and
      the measurement ID; `FND-001c` rides the Firebase config rather than
      configuring GA4 separately.
- [ ] **Enable Authentication** → Sign-in method, with both providers the app
      uses (`src/auth/authService.ts`): **Anonymous** and **Google**. The smoke
      test starts an anonymous session, so a missing Anonymous provider fails the
      deploy at its last step rather than at deploy time.
- [ ] **Create the Firestore database** in Native mode. Pick the region
      deliberately — it cannot be changed later, and `DEC-009` may impose a
      regional constraint on where user data lives.
- [ ] **Enable Cloud Storage.** Needed for the factory library (`CNT-000`); the
      deploy pipeline also ships `storage.rules` on every run, which fails
      without a bucket.
- [ ] **Enable Hosting.** The default site is named after the project ID.
- [ ] **Register a Web app** under Project Settings → General → Your apps. Copy
      its SDK config; those are the `VITE_FIREBASE_*` values in
      [`.env.example`](../../.env.example). They are public-by-design and ship in
      the client bundle — the API key identifies the project, it does not
      authorize anything that security rules do not already allow.

### The deploy service account

- [ ] Create a service account in the Google Cloud console (IAM & Admin →
      Service Accounts) for CI deploys only. Keep it distinct from any credential
      `library:upload` uses, so the deploy pipeline's IAM scope does not have to
      match a content task's.
- [ ] Grant it enough to deploy Hosting, Firestore rules **and indexes**, and
      Storage rules. A reasonable starting set:
      `roles/firebasehosting.admin`, `roles/firebaserules.admin`,
      `roles/datastore.indexAdmin`, and `roles/serviceusage.serviceUsageConsumer`
      (firebase-tools calls the Service Usage API on most commands). This set has
      not been exercised against a live project — treat the first `deploy` run in
      part 4 as the real check, and read the failure rather than guessing if it
      is short. `roles/firebase.developAdmin` is the broader fallback if you would
      rather not tune it during an outage.
- [ ] Add `roles/firebaseauth.admin` if per-PR preview channels are in use
      (`.github/workflows/preview.yml`). The Firebase CLI syncs each new channel
      URL into Authentication's authorized-domain list, which is what makes
      Google sign-in work on a preview URL; without this role the preview still
      deploys and anonymous start still works, and only `signInWithPopup` fails
      there. Not needed for the production `deploy` job itself.
- [ ] **Cloud Functions** (#282's usage triggers, #854's sign-in gate) deploy
      in the same `deploy` job. The deploy account cannot enable APIs or grant
      roles, so a project owner does all of this once, before the first deploy
      that carries functions. Each item below was a separate deploy failure the
      first time round. `<N>` is the project number, `<bucket>` the default
      bucket (`<project>.firebasestorage.app`), `<deployer>` the deploy account.
      - The **Blaze** plan.
      - **APIs:** Cloud Functions, Cloud Build, Artifact Registry, Cloud Run
        Admin, Eventarc, Cloud Billing (Firebase checks Blaze through it) and,
        optionally, Firebase Extensions (silences a warning).
      - **Roles on `<deployer>`**, granted to the deploy account itself, never
        to the appspot account: Service Account User (to act as
        `<project>@appspot.gserviceaccount.com`, which the functions run as),
        Cloud Functions Admin, Cloud Run Admin, Artifact Registry Writer, Cloud
        Build Editor, Eventarc Admin and Browser.
      - **Service-agent roles** (the deploy prints these if they are missing):
        ```sh
        gcloud projects add-iam-policy-binding <project> --member=serviceAccount:service-<N>@gs-project-accounts.iam.gserviceaccount.com --role=roles/pubsub.publisher
        gcloud projects add-iam-policy-binding <project> --member=serviceAccount:service-<N>@gcp-sa-pubsub.iam.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator
        gcloud projects add-iam-policy-binding <project> --member=serviceAccount:<N>-compute@developer.gserviceaccount.com --role=roles/run.invoker
        gcloud projects add-iam-policy-binding <project> --member=serviceAccount:<N>-compute@developer.gserviceaccount.com --role=roles/eventarc.eventReceiver
        gcloud projects add-iam-policy-binding <project> --member=serviceAccount:service-<N>@gcp-sa-eventarc.iam.gserviceaccount.com --role=roles/eventarc.serviceAgent
        ```
      - **Bucket read for the Storage triggers**, which Eventarc checks before
        it creates one:
        ```sh
        gcloud storage buckets add-iam-policy-binding gs://<bucket> --member=serviceAccount:service-<N>@gcp-sa-eventarc.iam.gserviceaccount.com --role=roles/storage.legacyBucketReader
        gcloud storage buckets add-iam-policy-binding gs://<bucket> --member=serviceAccount:<deployer> --role=roles/storage.legacyBucketReader
        ```
      - **An Artifact Registry cleanup policy** in the functions' region, or the
        deploy fails after the functions are created:
        `npx firebase-tools functions:artifacts:setpolicy --project <project> --location us-east1`.
      - The functions' region (`setGlobalOptions` in `functions/src/index.ts`)
        must match the bucket's location; production's is `us-east1`.
      - Before the first deploy with the sign-in gate, follow
        [`alpha-allowlist.md`](./alpha-allowlist.md) (Identity Platform, seed
        the allowlist, grant an admin, turn off Anonymous).
- [ ] Create a JSON key for it and keep it somewhere you can paste from once.
      It goes into a GitHub secret in part 3 and nowhere else — never into a
      developer `.env`, never into the repo. `.gitignore` already covers the
      obvious filenames, but the reliable guarantee is that it never lands on
      disk in a working tree.

## Part 2 — the Sentry project

Per [ADR 0001](../adr/0001-sentry-for-error-monitoring.md). If `DEC-009` lands a
regional data constraint that Sentry's SaaS regions cannot meet, stop — that
reopens the self-hosting option the ADR rejected, and this part changes.

- [ ] Create the organization (or use an existing one) and a project with
      platform **JavaScript → Solid**. Note the org slug and project slug; both
      are configuration, not secrets.
- [ ] Copy the project's **DSN** (Settings → Client Keys). This is public by
      design: a browser SDK cannot submit an event without it, and it grants
      nothing but the ability to submit. It ships in the client bundle and is
      stored as a repository *variable* so nothing pretends otherwise.
- [ ] Create an **auth token** (Settings → Auth Tokens) scoped to
      `project:releases` and `org:read`, for the one project above. This one *is*
      a real secret — it can create releases and rewrite what your error data
      says. CI only. `scripts/verify-no-secrets-in-bundle.mjs` fails the build if
      it ever appears in built output.
- [ ] Confirm **Session Replay is enabled** for the project, per
      [ADR 0002](../adr/0002-sentry-session-replay.md), which supersedes ADR 0001
      decision 4. Replay is for understanding how the app is used, never for
      reaching the user's music: the protection is mask-by-default *capture* in
      the client, so verify the client configuration rather than trusting a
      console toggle. Do not adjust masking, sampling, or canvas capture from the
      Sentry console — those are set in `src/monitoring/sentrySink.ts` and
      covered by tests; a console override would silently diverge from them.
      Until the client work lands (see the Session Replay disclosure and opt-out
      issue), replay captures nothing regardless of this project setting.

## Part 3 — GitHub Actions configuration

- [ ] **Create the `prod` environment.** `trygroove/groove` → Settings →
      Environments → New environment, named exactly `prod`. The `deploy` job
      declares `environment: prod`, and that name is how it finds the six values
      below. No protection rules or branch policy are required for the alpha —
      the job's own `if:` already restricts it to `push` events on `main` — but
      this is where you would add a required reviewer later.

Then set all six **inside that environment**, not at repository scope. The split
between variables and secrets is deliberate throughout: a value that ships to
browsers is not stored as if it were confidential.

| Name | Kind | Value |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Variable | The project ID from part 1 — where the deploy *ships to*. |
| `FIREBASE_DEPLOY_SERVICE_ACCOUNT` | **Secret** | The full service-account JSON, inline. |
| `VITE_FIREBASE_API_KEY` | Variable | Firebase console → Project settings → your web app → SDK setup. Public by design. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Variable | Same panel. |
| `VITE_FIREBASE_APP_ID` | Variable | Same panel. |
| `VITE_POSTHOG_KEY` | Variable | PostHog → Project settings → Project API key (`phc_…`). Public by design; the app runs without analytics when unset. |
| `VITE_POSTHOG_HOST` | Variable | `https://eu.i.posthog.com`, or `https://us.i.posthog.com` for a US project. |
| `VITE_SENTRY_DSN` | Variable | The DSN from part 2. Public by design. |
| `SENTRY_ORG` | Variable | Org slug. |
| `SENTRY_PROJECT` | Variable | Project slug. |
| `SENTRY_AUTH_TOKEN` | **Secret** | The auth token from part 2. |

The `VITE_FIREBASE_*` values are the Firebase **client** config — what the built
app talks to, as opposed to `FIREBASE_PROJECT_ID`, which is where the deploy
ships. Only the four above are stored: the client's project ID, auth domain, and
storage bucket are derived from `FIREBASE_PROJECT_ID` in `ci.yml` (Firebase names
the latter two `<id>.firebaseapp.com` and `<id>.firebasestorage.app` by
convention), so no value is written down twice and none can drift from the
project actually being deployed to.

They are inlined into the browser bundle at build time, so they must be set
*before* the deploy that is meant to use them — setting them afterwards changes
nothing until something rebuilds. Leaving them unset does not fail the deploy: it
ships an app that loads and then dies on its first Auth call with
`auth/invalid-api-key`. `bun run verify:client-config` runs in `predeploy` to
turn that into a build failure instead.

- [ ] Set all of them. **Scope matters more than it looks**: a job only receives an
      environment's variables and secrets if it declares that environment, and an
      environment-scoped `vars.*` lookup from a job that does not resolves to the
      empty string with no error. Setting these at repository scope instead
      leaves the `deploy` job reading blanks.
- [ ] Partial configuration degrades cleanly rather than breaking: without the
      `SENTRY_*` values the deploy still ships and source maps are still
      generated and still withheld from Hosting — they are simply not uploaded,
      so stack traces stay minified. `FIREBASE_PROJECT_ID` and
      `FIREBASE_DEPLOY_SERVICE_ACCOUNT` are not optional; with either missing the
      deploy step fails rather than silently skipping.

## Part 4 — the first deploy

- [ ] Merge anything to `main`, or re-run the latest `main` workflow. The
      `deploy` job should now run instead of skipping.
- [ ] Watch it through its steps: write the credential → `bun run deploy`
      (builds, scans for secrets, ships Hosting + Firestore rules/indexes +
      Storage rules in one command) → mark the release deployed in Sentry →
      install Chromium → smoke test against the public origin
      (`site.config.mjs`'s `SITE_ORIGIN`, `https://trygroove.app`).
- [ ] Confirm the site loads and `ReleaseBadge` shows the deployed commit SHA.

The smoke test (`tests/e2e/hosted/smoke.spec.ts`) has never been run against a real
environment — it cannot be, without one. It drives real Authentication and
Firestore, and it is the first thing here that exercises your rules and providers
end to end. Expect it to be where a missing Anonymous provider or an over-tight
Firestore rule surfaces. A failing smoke test is a failed deploy; that is the
intended behavior, not a flake to retry past.

- [ ] Apply the Storage bucket CORS policy so the browser can read library
      assets: `bun run library:upload -- --configure-bucket`
      (`storage.cors.json` substitutes the project ID). Uploading the library
      itself is `CNT-000`, not this runbook.

## Part 5 — verify analytics and errors

The full procedure lives in
[`docs/testing.md`](../testing.md#verifying-analytics-and-errors-against-a-deployed-build)
— follow it there rather than duplicating it here. It is written as a procedure
and has never been executed; you are its first run.

In short:

- [ ] Mark your own browser as internal first (`?internal=1`), so verification
      traffic is excluded from the PRD section 11 measures.
- [ ] Confirm collection is on in the Privacy disclosure, and disable any
      tracker blocker — a blocked endpoint looks exactly like a broken pipeline.
- [ ] Trigger and confirm each Alpha Milestone 0 event in GA4 Realtime: `app_opened`,
      `first_edit`, `feature_first_use`, `save_failed`, `audio_start_failed`,
      `exception`.
- [ ] Throw a deliberate error from the console and confirm the Sentry issue
      carries the deployed SHA, a **symbolicated** stack trace naming `src/`
      files, the expected tags, a redacted message, and no PII — and that it
      produced exactly one issue.
- [ ] Exercise the opt-out in both directions, including GA4's automatic
      collection (`page_view`, `session_start`), and confirm no `_ga` cookie is
      written for a session that declined before the SDK initialized.
- [ ] Confirm no source map is publicly fetchable:
      `curl -sI https://trygroove.app/_build/assets/<chunk>.js.map` must
      not return 200.

Minified frames in Sentry mean the source-map upload did not run — check
`SENTRY_AUTH_TOKEN` in the deploy log. A `.js.map` that returns 200 is a leak,
and the deploy should be treated as one.

## Part 6 — the rollback drill

`FND-001b` requires rollback to have been *performed once as evidence*, not just
described. This is the only part of the runbook that is deliberately a rehearsal:
do it immediately after part 5, on a deploy you are happy to lose, rather than
discovering the procedure during an incident.

Deploy a trivially visible change (a copy tweak is enough) so you can see the
rollback take effect, then:

- [ ] **Hosting.** `firebase-tools` 15 has no `hosting:versions:list` — find the
      previous version ID in the console under Hosting → your site → Release
      history. Then:
      ```sh
      bunx firebase hosting:clone <site-id>@<PREVIOUS_VERSION_ID> <site-id>:live \
        --project "$FIREBASE_PROJECT_ID"
      ```
      Mind the separators. The source uses `@`, the target uses `:live`, and the
      command is silent about getting it wrong: `hosting:clone` splits the source
      on `:` first, so `<site-id>:<VERSION>` is read as a *channel* name and
      fails with `Could not find the channel <VERSION>`. For the default site,
      `<site-id>` is the project ID. The console's Rollback button does the same
      thing in one click.
- [ ] **Firestore rules.** Every past revision is in git against the SHA that
      deployed it. `firebase.json` always points at the working tree's
      `./firestore.rules`, so overwrite that file rather than a copy:
      ```sh
      git checkout <previous-commit> -- firestore.rules
      bunx firebase deploy --only firestore:rules --project "$FIREBASE_PROJECT_ID"
      ```
      Then immediately commit the reverted rules, or `git checkout HEAD --
      firestore.rules` once the incident is over, so the working tree and the
      deployed rules do not silently diverge.
- [ ] **Confirm.** `SMOKE_URL=https://trygroove.app bun run smoke:hosted`
      before calling the rollback complete.
- [ ] Roll forward again and record the drill in `FND-001b`'s checklist.

Because Hosting release history and rules revisions are both keyed to the commit
SHA that `ReleaseBadge` and every analytics and error event carry, an incident
report can name exactly which release was live before and after.

## Part 7 — close the gate

These acceptance criteria are the ones no amount of implementation work could
close, because they each require a real environment. They are what `G4.5` waited
on; it opened on 2026-08-06. Tick them on [issue #68 (`OPS-001`)](https://github.com/trygroove/groove/issues/68) only from observed
results — except the two deferred by `DEC-012`, noted below:

| Task | Criterion | Closed by |
| --- | --- | --- |
| `FND-001b` | Post-deploy smoke test run against the hosted URL | Part 4 |
| `FND-001b` | Rollback performed once as evidence | Part 6 |
| `FND-001c` | Alpha Milestone 0 events observed from a deployed build | Part 5 |
| `FND-001c` | A deliberately triggered error arrives in Sentry with its SHA and a symbolicated trace | Part 5 |
| `FND-009` | The vertical slice exercised on the hosted environment, and its events observed there | Parts 4 and 5 |
| `LOOP-016` | Every Alpha Milestone 1 OPS-02 event observed from the deployed build | Part 5 |
| `REL-001` | Every Alpha Milestone 2 OPS-02 event observed | Part 5 |

Computing the primary success measure from real events was originally part of
that last row. It is **deferred to post-alpha** (`DEC-011`, PRD section 16): the events still fire and are still covered by automated tests, but the
measure's thresholds and definition need more consideration than the alpha can
give them. Do not tick anything here for it, and do not treat its absence as an
outstanding defect.

Parts 4 and 5 now cover more than they did when this runbook was written for
Alpha Milestone 0: the deployed build contains the whole Alpha Milestone 0-2
feature set, so the event list to confirm in part 5 is every Alpha Milestone 0,
1, and 2 event in the OPS-02 catalog, not only the six Alpha Milestone 0 ones.

- [x] Update `docs/testing.md`'s "What has not been verified" section to record
      what you actually observed, with the date and the release SHA. That section
      exists because a procedure nobody has run is not evidence; leaving it
      standing after you have run it is the same failure in the other direction.
      **Done 2026-08-05** against release `8336d9d`; the section is now
      "What has been verified against the hosted environment".
- [x] Mark **G4.5: Hosted environment verified** open. **Open 2026-08-06.**
      Deploy, rollback, analytics, and error monitoring are each verified
      against the hosted environment; the monitoring defect that originally held
      the gate ([#174](https://github.com/trygroove/groove/issues/174)) is
      fixed, and on release `e15ce13` a deliberately triggered error reaches
      Sentry's ingest endpoint with HTTP 200.

      Two console-inspection checks are **deferred to post-alpha by decision**
      (`DEC-012`, PRD section 16) rather than left outstanding: **(a)** opening
      the Sentry issue an error produces to confirm its release SHA,
      symbolicated `src/` trace, tags, redacted message, single-issue grouping,
      and crash-free session rate; **(b)** confirming the `internal` user
      property in GA4 and that internal traffic is excluded from the section 11
      measures. Neither affects a cohort session, both are covered by automated
      tests against a fake SDK, and source-map upload with matching debug IDs is
      independently confirmed. Re-run both once the alpha is built —
      `docs/testing.md` records the residual risk each carries.

## Out of scope

- **Uploading the factory library** (`CNT-000`) — needs its own credential and
  its own bucket layout. This runbook only applies the CORS policy the browser
  needs to read what that task publishes.
- **`DEC-009`** — the analytics default state, disclosure wording, and retention
  policy are the product owner's decision. `FND-001c` built the opt-out and the
  disclosure hook either way, but the cohort must not be invited (`HARD-005`)
  before it is settled.
- **A staging environment.** There isn't one, on purpose (PRD section 16). If
  that decision changes, it changes the PRD first. Per-PR Hosting *preview
  channels* (`.github/workflows/preview.yml`) are not one: they are extra
  Hosting releases inside this same project, sharing its live Firestore, Auth,
  and Storage. They need no extra provisioning here beyond the
  `roles/firebaseauth.admin` grant noted under "The deploy service account" —
  see [`docs/testing.md`](../testing.md), "Per-PR preview deploys".
