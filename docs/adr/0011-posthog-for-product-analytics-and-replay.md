# ADR 0011 - PostHog for product analytics and session replay; errors to both while PostHog is evaluated

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-10-12 |
| Decides | Which vendor receives product analytics and session replay, and how PostHog's error tracking is evaluated against Sentry's |
| Decided by | The product owner, on GRV-104 |
| Supersedes | [ADR 0001](./0001-sentry-for-error-monitoring.md) decision 3 (the `exception` counter goes to PostHog instead of Google Analytics); [ADR 0002](./0002-sentry-session-replay.md) and [ADR 0003](./0003-replay-canvas-capture-and-assistant-conversation-retention.md) in the vendor they name for replay only, not in their conditions |
| Affects | `OPS-02`, `OPS-03`, `DEC-009`, `src/analytics/` (transport, consent, internal traffic), `src/monitoring/` (replay), `src/firebaseConfig.ts`, `functions/` (the gateway's turn log), the disclosure copy |

## Context

Groove sends product analytics to Google Analytics 4 through Firebase Analytics (`src/analytics/firebaseTransport.ts`), and errors and session replay to Sentry (ADRs 0001 to 0003). GA4 has only just been set up, so there is no history or reporting to keep, and moving costs little.

The next measurement work is about the assistant:

- **Sad assistant sessions** (GRV-103): the share of conversations with at least one bad response, broken down by cause, and the producers behind them.
- **LLM metrics** (GRV-102 offline, production here): latency, tokens and cost per turn, by model and prompt version.
- **Diagnosing a bad session**: seeing what the producer did around a rejected proposal or an undo.
- **Prompt changes judged in production**: comparing a prompt or model change against the sad-session rate.

GA4 handles plain event counts, which is enough for the sad-session ratio, and little else on that list:

- Reports lag by up to a day, and explorations are fixed report shapes, with no query over raw events.
- At alpha volume, data thresholds and sampling hide or estimate the small counts we actually have.
- An event takes at most 25 parameters, a property at most 50 custom dimensions, and a value at most 100 characters.
- Server events go through the Measurement Protocol, which is awkward for the Cloud Functions gateway.
- It has no feature flags, experiments or surveys.

A GA4 event cannot link to a Sentry replay, so a chart of bad sessions cannot open the recordings behind it.

PostHog covers the list in one tool: SQL over raw events (HogQL), funnels and cohorts per person, real-time ingestion, LLM analytics fed by one event per model call, feature flags and experiments, in-app surveys, and session replay linked to the same events and people.

Sentry is used in the browser only, for two jobs: errors (source maps from `@sentry/vite-plugin`, our scrubbing in `src/monitoring/scrub.ts`, grouping by release) and session replay (mask-by-default with canvas capture, `src/monitoring/replayPrivacy.ts`). Its error tracking is mature and tuned. PostHog also tracks errors, and its errors would sit beside the events and replays of the same session. Its tracker is younger, so it has to earn the switch: we run it alongside Sentry and compare.

## Decision

### 1. PostHog replaces Google Analytics for product analytics

A PostHog transport implements `AnalyticsTransport` (`src/analytics/transport.ts`) and becomes the one wired in. The Firebase Analytics transport and GA4's automatic collection are removed. The typed catalog (`src/analytics/catalog.ts`) stays the only way an event is defined, and its parameter rules (no names, no user text, no URLs, no tokens) apply unchanged. That includes the `exception` counter from ADR 0001 decision 3, which now goes to PostHog.

- **Autocapture is off.** It would record element text, which includes project, track, clip and section names. Pageview capture comes from the router, not autocapture.
- **Persons are identified by Firebase UID only**: no email and no name as person properties. Internal traffic (`src/shared/internalTraffic.ts`) becomes a person property and an exclusion filter, replacing GA4's `traffic_type`.
- **Consent:** collection follows `src/analytics/consent.ts` exactly as today. Opted-out sessions get no transport, and PostHog runs cookie-less until consent is given.
- **EU Cloud** hosting, unless DEC-009 decides otherwise.

### 2. Session replay moves from Sentry to PostHog

Replay runs in PostHog so a recording can be filtered by the events in it (for example, every session with `assistant_session_sad`). Sentry replay is turned off in the same change, so only one vendor ever records.

Every condition ADRs 0002 and 0003 set for replay still applies, re-expressed in PostHog's controls: text and inputs masked by default with named unmasks only, canvas capture on and disclosed, sampling, the opt-out, the purpose limit, and a payload test proving masked text is never sent. Replay moves only once all of them hold in PostHog.

### 3. Errors go to Sentry and PostHog while PostHog is evaluated

Sentry remains the error system of record (ADR 0001 decisions 1, 2 and 6 unchanged). PostHog error tracking runs beside it, for evaluation:

- **One boundary, two sinks.** A PostHog `ErrorSink` sits next to `sentrySink.ts` behind the reporting boundary (`src/monitoring/errorReporting.ts`), and the boundary sends every report to both. Application code still never calls either SDK. A failing sink never stops the other or causes another report.
- **The same scrubbing.** Both sinks receive the report only after `src/monitoring/scrub.ts` has cleaned it, and the "no project content" payload test covers the PostHog payload too. PostHog's own exception autocapture is off, so nothing reaches it except through the boundary.
- **Source maps** are uploaded to PostHog as well as Sentry, per release, and never published.
- **Alerts and triage stay in Sentry** for the evaluation.

After at least four weeks of production traffic, a follow-up ADR keeps one tracker, judged on:

1. **Capture:** the same errors arrive in both (counts per release within a few percent).
2. **Readability:** stack traces symbolicate against our source maps.
3. **Grouping:** one bug is one issue, and two bugs are not merged.
4. **Release health:** a crash-free session rate we can gate a release on (`OPS-03`).
5. **Alerting:** a new or regressed issue reaches us as fast as Sentry's.
6. **Context:** going from an error to its session's events and replay is worth more than any gap in 1 to 5.
7. **Cost and bundle size** of each.

If PostHog wins, Sentry is removed and this ADR's single-vendor consequence holds in full. If not, the PostHog sink is removed.

### 4. The assistant gateway sends one LLM event per turn, with no content

`functions/` sends one PostHog `$ai_generation` event per turn, built from `AssistantTurnLog` (`src/assistant/telemetry.ts`): model, prompt version, outcome, stop reason, duration, token counts, attempts, and failure kinds. It is attributed to the turn's Firebase UID.

**Content capture is off.** No prompt, reply, tool input, project context or library is sent (`$ai_input` and `$ai_output` stay unset). Kept conversations live only in our own Firestore, as ADR 0003 requires. Sending this event must never delay or fail a turn.

### 5. Prompt experiments use PostHog feature flags

A prompt or model change may be rolled out behind a PostHog flag and judged against the sad-session rate. The flag is evaluated in the browser and sent with the turn request, and the gateway picks the prompt variant from it. The gateway never asks PostHog for it on the turn path.

## Consequences

### What this buys

- The sad-session rate, its causes and the people behind it, from one event store with SQL, available in real time.
- Latency, tokens and cost per turn in production, by model and prompt version, beside the offline eval scorecard (GRV-102).
- One click from a bad session to its recording.
- A way to hill-climb on production data: flag a prompt change and compare.
- No thresholding or sampling hiding small alpha counts.
- One analytics vendor instead of two (Google Analytics leaves), and a measured way to find out whether PostHog can replace Sentry too, leaving one vendor for everything.
- Errors beside the session's events and replay in PostHog, during the evaluation.

### What this costs, and what we do about it

- **Acquisition reporting:** Google Ads attribution, Search Console linking and the free BigQuery export are lost. Nothing uses them yet. If landing-page marketing needs them, GA can return on `/` only, behind the same transport seam.
- **Privacy surface moves, and replay's checks are redone.** The masking setup and payload test ADRs 0002 and 0003 require have to be rebuilt against PostHog's recorder. The disclosure copy and DEC-009 change to name PostHog for analytics and replay.
- **Ad blockers block PostHog** as they block GA and Sentry. A reverse proxy (for example on the existing Cloudflare Worker) is allowed but not required. The fail-open rule of `OPS-02` applies unchanged.
- **Bundle size.** The PostHog SDK loads lazily after first paint and not on the static landing page, as Sentry's does (ADR 0001). The replay recorder loads only when a session is sampled.
- **Cost.** The free tier covers alpha volume. Limits are confirmed at signup, not taken from secondary sources. Replay sampling is the main lever if it grows.
- **Errors are sent twice** during the evaluation: two payloads to keep clean, and the payload test covers both. The PostHog sink uses the analytics SDK already loaded, so it adds little bundle.
- **Server errors stay uncovered.** The Cloud Functions report to neither Sentry nor PostHog, only to Cloud Logging. Sentry for the gateway (ADR 0001 decision 5) is still allowed and is separate work.

### Follow-up work

1. PostHog transport, consent and internal traffic; remove the Firebase Analytics transport (decision 1).
2. PostHog replay with the ADR 0002/0003 conditions and payload test; turn off Sentry replay; update the disclosure (decision 2).
3. PostHog error sink, source-map upload and the shared payload test (decision 3).
4. The gateway's `$ai_generation` event (decision 4).
5. Prompt-version feature flag (decision 5), once GRV-103 reports.
6. The follow-up ADR choosing one error tracker, after the evaluation (decision 3).
