# The assistant gateway

The assistant reaches its model provider (Anthropic, ADR 0006) through one
callable Cloud Function, `assistantTurn` (#69). The browser never holds the
provider's API key or talks to the provider directly.

## How it works

- `functions/src/index.ts` exports `assistantTurn`, a streaming callable in
  `us-east1`. Firebase verifies the caller's ID token; the gateway
  (`src/assistant/gateway.ts`) then refuses a guest, parses the request
  against ADR 0007's allowlist, calls the provider and streams the reply.
- The API key is the Secret Manager secret **`ANTHROPIC_API_KEY`**
  (`ASSISTANT_API_KEY_SECRET` in `src/assistant/config.ts`), bound to
  `assistantTurn` alone.
- The model, and how its request is shaped, are configuration in
  `src/assistant/config.ts`. Switching between `claude-sonnet-5` and
  `claude-haiku-4-5` is a change to `ASSISTANT_MODEL_ID` and a deploy.
- Each turn logs one `assistant turn` record to Cloud Logging: outcome code,
  model, prompt version, attempts, failure kinds, token counts, duration, and
  how many recommended videos were shown and dropped. Never the conversation,
  the project, the account or the provider's error text.
- A tutorial video the model recommends (GRV-16, ADR 0009) is checked from
  `assistantTurn` against YouTube's public oEmbed endpoint
  (`https://www.youtube.com/oembed`, no key, plain outbound HTTPS, no Google
  Cloud API). A video it does not describe is dropped, and while it is
  unreachable every video is dropped: `videosDropped` climbing with
  `videosShown` at 0 is the sign.

## Limits and the kill switch

ADR 0006 decisions 4 to 7. Every figure is in `ASSISTANT_LIMITS` in
`src/assistant/config.ts`, alongside the 30-day transcript retention window.

- **Per account: 100 requests in a rolling 24 hours.** Every provider call
  counts, retries included, so the number can be higher than the messages a
  producer sent. Kept in `assistantUsage/{uid}` as the times of the recent
  calls. Over the cap, the call fails with `resource-exhausted` and
  `details.resetsAt`, the time the oldest request leaves the window.
- **Organisation-wide: $25 per UTC day.** Each call's cost is estimated from
  the provider's token counts and the configured prices and added to
  `assistantSpend/{YYYY-MM-DD}` (in micro-dollars). At the ceiling every call
  fails with `unavailable` and `details.code: "spend_ceiling_reached"` until
  midnight UTC. Compare against the Anthropic console's usage page now and
  then: the figure is an estimate.
- **The kill switch.** To stop the assistant at once, with no deploy: in the
  Firebase console, Firestore, create (or edit) the document
  `assistantControl/settings` with a boolean field `enabled` set to `false`.
  Every call then fails with `details.code: "assistant_disabled"` before
  reaching the provider. Set it back to `true`, or delete the document, to
  turn it on again. A missing document means on.
- Clients cannot read or write any of the three collections
  (`firestore.rules`); only the function, with the admin credential, does.
- To give one account a fresh allowance (a tester hit the cap during a
  session you asked for), delete its `assistantUsage/{uid}` document.

## Before the first deploy that includes `assistantTurn`

`main` deploys functions on every merge (`bun run deploy` in
`.github/workflows/ci.yml`). A function that binds a secret cannot deploy
until the secret exists, so do these **before merging** the PR that adds the
gateway, or the next `main` deploy fails:

1. **Create the secret.** With the Firebase CLI signed in as a project owner:

   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY --project <project-id>
   ```

   Paste the Anthropic API key when prompted. This enables the Secret Manager
   API if it is not already on. Use a key from an Anthropic workspace whose
   spend limit you are comfortable with as a last line of defence.

2. **Let the deploy account bind it.** The deploy grants the functions'
   runtime service account access to the secret, so the service account in
   `FIREBASE_DEPLOY_SERVICE_ACCOUNT` needs the **Secret Manager Admin** role
   (`roles/secretmanager.admin`) in the project's IAM page. Without it the
   deploy fails with a permission error on the secret.

3. **Merge.** The `deploy` job deploys `assistantTurn` with the rest.

To check it is live: Cloud Functions in the Google Cloud console lists
`assistantTurn` in `us-east1`, with `ANTHROPIC_API_KEY` under its secrets.

## Why a proposal was rejected

A proposal the browser cannot apply logs `assistant_proposal_rejected` (its
kind, capability and issue codes, nothing else), so the rejection rate sits
beside the other proposal rates in analytics. A kept turn also records the
`rejected` outcome with each issue's code, the tool call it blames, and the
validator's own path and message (GRV-98).

To see one, sign in to `/admin` with the `admin` claim: **Assistant
transcripts** lists the newest kept turns (filter by account, project, outcome,
rating and internal traffic) through the `assistantTranscriptsAdmin` callable, and
**Open** shows the message, the reply, every tool call with its input, and the
outcomes with their issues. No client reads the collection directly, admins
included.

To make a failure a regression case, **Download eval case** on the opened turn
and run `bun run eval:assistant -- --from-transcript <file>`. A transcript
does not keep the song, so the file names an eval fixture to run the message
against (`house-loop` unless edited to `kit-sketch` or `arrangement`). The file
carries the producer's words: keep it off the repository.

## Sad assistant sessions

The production measure of assistant quality (GRV-103): the share of
conversations that went wrong at least once. A conversation's first sent
message logs `assistant_session_started`; its first bad response logs
`assistant_session_sad` (`src/assistant/sessionHealth.ts`). Each carries a
`reason` and a `signal_class`:

| `reason` | `signal_class` | What happened |
| --- | --- | --- |
| `turn_error` | `hard` | The turn failed: provider, timeout, quota, spend guard |
| `max_tokens` | `hard` | The reply was cut off |
| `refusal` | `hard` | The model refused |
| `proposal_invalid` | `hard` | A proposal did not fit the song |
| `proposal_stale` | `hard` | A proposal arrived after the song moved on |
| `proposal_undone_fast` | `soft` | A proposal was undone within 60 s of applying |
| `proposal_cancelled` | `soft` | A proposal was turned down |
| `rated_down` | `explicit` | The producer gave a reply a thumbs-down |

`assistant_session_sad` fires at most twice per conversation: with
`counts_for: full` on its first bad signal of any class, and with
`counts_for: hard` on its first hard or explicit one (both on the same signal
when that comes first). A conversation stays sad after it recovers, and a
thumbs-down changed to a thumbs-up does not take its event back.

PostHog (ADR 0011, GRV-106) has not landed, so the insight is defined here for
the product owner to create once it has. One **Trends** insight, weekly,
filtering out internal traffic (`traffic_type` = `internal`) on every series:

- **A**: `assistant_session_started`, total count.
- **B**: `assistant_session_sad` where `counts_for` = `full`, total count.
- **C**: `assistant_session_sad` where `counts_for` = `hard`, total count.
- Formulas: `B / A` (**full rate**) and `C / A` (**hard rate**), shown side by
  side, with A, B and C hidden.

A second insight breaks the full rate down by cause: `assistant_session_sad`
where `counts_for` = `full`, weekly, broken down by `reason`. The breakdown
counts each sad conversation once, under its first reason. Link both here once
they exist.

To read the conversations behind a thumbs-down, filter **Assistant
transcripts** in `/admin` to **Rated down**. A rating is only kept on a turn
the account lets Groove keep.

## Rotating the key

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY --project <project-id>
firebase deploy --only functions:assistantTurn --project <project-id>
```

A function reads the secret version it was deployed with, so the redeploy is
what picks up the new key. Then disable the old key in the Anthropic console.

## Running it locally

The emulator loads `assistantTurn` without a key, and with no key it answers
from a scripted provider (`src/assistant/emulatorProvider.ts`): a short reply
streamed in pieces, or, by a marker in your message, a reply that hangs until
you press Stop (`[hang]`), one that fails once and then works (`[flaky]`), or
one that ends in a proposal (`[propose]`), or one that ends in a question for
you with options (`[ask]`, `[ask-multi]` for several picks, or `[ask-rich]`
for options that point at the first track and bars 1-2, can be heard, and
answer themselves when you set the tempo to 100 BPM or below; GRV-42), or one
that recommends a tutorial video (`[video]`, GRV-16: one real video, which the
emulator vouches for without asking YouTube, and one it drops). Two
scripts serve the core flows: "Loosen the beat" proposes swing and a quieter
track (CF-027), and asking for something dusty or dustier recommends kicks from
the library the turn carries (CF-034). The browser suite drives the real
gateway that way. To try it against the real provider, put
`ANTHROPIC_API_KEY=<key>` in `functions/.secret.local` (gitignored by
`*.local`) and restart the emulators. The automated suites never use a key:
the unit suites script the provider (`src/testing/scriptedAssistantProvider.ts`)
and the browser suite uses the emulator's.
