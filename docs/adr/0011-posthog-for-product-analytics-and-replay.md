# ADR 0011 - PostHog for product analytics and session replay; errors to both while PostHog is evaluated

| Field | Value |
| --- | --- |
| Status | Accepted |
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

### 4. The assistant gateway sends one LLM event per provider call, traced per turn and grouped per conversation, with content for kept accounts

*Rewritten by GRV-126.* As first decided, this was one content-free event per turn. Debugging the assistant needs the conversation itself in PostHog's AI Observability, beside the session's events and replay, so it is now:

- **One `$ai_generation` event per provider call**, retries and later steps of a turn included, sent from `functions/` with `posthog-node` to the project's own ingestion host (the `POSTHOG_HOST` param, US by default, where the project is) with its public key (the `POSTHOG_KEY` param, `VITE_POSTHOG_KEY`'s value). It is attributed to the turn's Firebase UID, the same `distinct_id` the browser identifies with.
- **One trace per turn, one AI session per conversation.** `$ai_trace_id` is the turn ID the request's `session` names, or a fresh ID for the turn when it names none. `$ai_session_id` is the conversation ID, so PostHog's Sessions view groups a conversation's turns; a turn with no `session` sends it as `null`, which tells PostHog that trace stands alone. (The first version traced a whole conversation as one trace and sent no `$ai_session_id`, which PostHog flagged; GRV-126 QA.) Each event carries `$ai_span_id`, `$ai_model`, `$ai_provider`, the input, output and cache token counts, `$ai_latency`, `$ai_is_error`, `$ai_http_status` and `$ai_stop_reason`, and beside them `prompt_version`, the turn's `outcome`, the `attempt`, the `failure_kind` and the `internal` flag the project's internal-traffic filter reads. The browser sends PostHog's `$session_id` with the turn, so a trace links to its session's replay. No `$ai_trace` event: PostHog builds the trace from the generations.
- **Only with product analytics allowed.** The browser sends its `productAnalytics` consent with every turn; declined or missing, no event is sent at all.
- **Content only for kept accounts.** `$ai_input` (the system prompt with the project context, and the messages), `$ai_tools` and `$ai_output_choices` (the reply's text and tool calls) are set only when the account lets Groove keep its conversations (`permitsRetention`, read from the transcript store on the same turn) as well as allowing product analytics. Otherwise the event carries codes, counts and durations only. This is the one deliberate exception to "no user text in events", and it is scoped to these `$ai_*` events from the gateway: the `src/analytics` catalog and its parameter rules are unchanged, and ADR 0003 decision 2 is amended to match.
- **Sending never delays or fails a turn.** Events are queued as the turn ends and flushed, with a two-second limit, before the function returns; a PostHog failure is logged as a code only. `src/assistant/traces.ts` decides what an event says, `functions/src/posthogTraces.ts` sends it.

Turning keeping off stops new content going to PostHog but does not delete what PostHog already has; those copies expire under PostHog's data retention, and the disclosure says so (`src/editor/assistant/retentionCopy.ts`). Deleting them on opt-out is out of scope, by choice.

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
- **Bundle size.** The PostHog SDK is its own chunk, loaded lazily when the browser is idle after first paint, never in the prerendered shell or the entry chunk. *Amended by GRV-123:* it now loads on the landing page `/` too, so a visit that never goes on into the app is still measured, but there it waits longer (after the window `load` event, a further three seconds and an idle callback, so its download and parse fall outside the window that decides `/`'s LCP and TBT) and it is the **analytics SDK only** (catalog events, `$pageview` and `$pageleave`). Session replay, the PostHog error sink, web vitals and network timing start only once the session reaches an app surface, and the web-vitals code and the replay recorder are not fetched before then; the recorder loads only when a session is sampled. ADR 0001's rule for Sentry is unchanged: no monitoring SDK loads on `/`. `scripts/verify-bundle-budget.mjs` fails the build if either SDK lands in an eagerly loaded chunk.
- **Cost.** The free tier covers alpha volume. Limits are confirmed at signup, not taken from secondary sources. Replay sampling is the main lever if it grows.
- **Errors are sent twice** during the evaluation: two payloads to keep clean, and the payload test covers both. The PostHog sink uses the analytics SDK already loaded, so it adds little bundle.
- **Server errors stay uncovered.** The Cloud Functions report to neither Sentry nor PostHog, only to Cloud Logging. Sentry for the gateway (ADR 0001 decision 5) is still allowed and is separate work.

### Follow-up work

1. PostHog transport, consent and internal traffic; remove the Firebase Analytics transport (decision 1).
2. PostHog replay with the ADR 0002/0003 conditions and payload test; turn off Sentry replay; update the disclosure (decision 2).
3. PostHog error sink, source-map upload and the shared payload test (decision 3).
4. The gateway's `$ai_generation` events (decision 4, GRV-126).
5. Prompt-version feature flag (decision 5), once GRV-103 reports.
6. The follow-up ADR choosing one error tracker, after the evaluation (decision 3).
