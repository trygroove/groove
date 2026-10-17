# ADR 0003 - Canvas capture in Session Replay, and first-party retention of assistant conversations

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-06 |
| Decides | Whether Session Replay captures the arrangement and piano roll, and where assistant conversations are retained for product analysis |
| Supersedes | [ADR 0002](./0002-sentry-session-replay.md) decision 2's "canvas capture stays off" |
| Affects | `OPS-02`, `OPS-03`, `DEC-009`, `HARD-006`, `OPS-001`, the disclosure copy |

## Context

[ADR 0002](./0002-sentry-session-replay.md) enabled Session Replay for product understanding under mask-by-default capture, and turned canvas capture off — which kept "the arrangement renderer, the piano roll, and waveform displays out of the payload entirely." It also predicted its own failure mode, in its consequences: *"if a specific surface proves unreadable, the fix is to unmask that named static element."*

That prediction was too optimistic about which surface would prove unreadable. The problem is not one static element. In a DAW, the arrangement and the piano roll **are** the application; a replay with both blanked shows a user moving a pointer across an empty rectangle. The interactions ADR 0002 exists to observe — dragging the wrong edge of a clip, hunting for a control, editing notes that do not land where the user meant — happen inside exactly the two surfaces it excluded. The result is a instrument that answers its motivating question ("where do people get stuck?") least well precisely where getting stuck is most likely.

Separately, ADR 0002 left a real product need unaddressed. Understanding whether the assistant works — what people ask it, how they phrase requests, which replies they accept or abandon — requires the conversation text. `OPS-02`'s catalog forbids assistant prompts and replies as event parameters, and ADR 0002's masking keeps them out of the replay payload. Both rules are correct about Sentry and neither answers the need.

The temptation was to solve the second problem with the first mechanism: unmask the assistant panel in replay. This decision rejects that. Replay is sampled at a low rate, retained briefly, and not queryable as text; it is a poor vehicle for analysing language. More importantly, routing free-form user text to a third-party processor is the most consequential thing this stack could do with it, and it would be done for a use case a first-party store serves better.

## Decision

### 1. Canvas capture is enabled, and the arrangement and piano roll are recorded

`canvas: true` in the replay integration. The arrangement renderer, the piano roll, and waveform displays are serialized into the replay payload.

This is a deliberate expansion: **the user's musical work is now visible in sampled recordings.** It is the cost of replay being useful at all for the editing surfaces, and it is accepted for that reason and no other. It does not license any other use — decision 4 below.

The text-masking rules from ADR 0002 decision 2 are **unchanged**. `maskAllText: true` and `blockAllMedia: true` still hold, and clip names, track names, typed input, and the assistant panel remain masked at capture in the DOM.

The canvas is the exception, and it is worth being exact about how far it goes. The arrangement renderer draws user-authored **section names** into the content layer (`src/arrangement/canvasRenderer.ts`), alongside clip blocks, note previews, and audio waveforms. Canvas capture records all of it. So the honest statement is not "canvas reveals structure but not names" — it is that **inside the canvas, masking does not apply at all**, and the section names drawn there are recorded along with everything else. Keeping them out would mean changing the renderer, which buys little once the arrangement itself is recorded; the disclosure (decision 5) covers this rather than a partial technical measure pretending to.

Three consequent scoping decisions, settled with the ADR rather than left to the implementing PRs:

- **`ConfirmDialog` masks its title only.** The title interpolates a name (`Delete "…"?`); the explanatory message does not, and a delete confirmation is exactly the friction replay exists to show.
- **Asset, pad, and pack names stay unmasked.** They are library facts we ship, identical for every user, and which sound someone reached for is behavioural signal worth having. This stops being true the day users can upload or rename their own samples — at which point it is revisited, not silently inherited.
- **DOM `aria-label` is masked** via an explicit `maskAttributes` list. Names reach the DOM through attributes as well as text nodes, and Sentry's `maskAttributes` replaces its default rather than extending it, so the list names `title` and `placeholder` too.

### 2. Assistant conversations are retained as first-party data, never sent to Sentry

Assistant prompts and replies are retained in our own Firestore, under the project that produced them, for product analysis. They are **not** unmasked in replay, **not** added to the `OPS-02` catalog as event parameters, and **not** transmitted to Sentry or any other third-party processor. The `OPS-02` and `OPS-03` content rules are unchanged and their tests keep passing verbatim: assistant text stays out of every event and every replay payload.

This keeps the third-party surface exactly where ADR 0001 and ADR 0002 left it, and it puts the more sensitive data in the store where we control retention, deletion, access, and region.

*Amended by GRV-126 ([ADR 0011](./0011-posthog-for-product-analytics-and-replay.md) decision 4).* A kept conversation now also goes to one third-party processor, PostHog, as the content of the assistant gateway's `$ai_generation` events: the request sent to the provider (system prompt, project context, tools and messages) and the reply. Debugging the assistant means reading a conversation beside the calls, tokens, latency and session that produced it, which our own store cannot show. It goes only for an account that lets Groove keep its conversations **and** allows product analytics, and only in those `$ai_*` events from `functions/`: it is still never an `OPS-02` catalog parameter, never in a replay payload, and never sent to Sentry. Turning keeping off stops new conversations going there; what PostHog already holds is not deleted but expires under PostHog's data retention, and the disclosure says so.

### 3. First-party retention carries its own obligations, which are not weaker than the third-party ones

Retention in our own database is not a privacy-neutral move; it is a different set of duties, and all of them are load-bearing:

- **Access is restricted and audited.** Assistant conversations are readable for product analysis, not for browsing. Firestore rules keep them owner-scoped, the same as project content.
- **Deletion is real.** Deleting a project deletes its conversations. An account deletion request removes them. Retention is bounded and the bound is set by `DEC-009` alongside the other retention questions, not left indefinite by default.
- **Opt-out covers it.** A user who declines telemetry has their conversations excluded from retention-for-analysis. Consent (`src/analytics/consent.ts`) gains the flag; declining costs no assistant capability, exactly as `OPS-02` requires.
- **It is disclosed specifically.** The disclosure says assistant conversations are kept and why. "We store your chats with the assistant" is not something a user should have to infer from a privacy policy's general terms.

### 4. The purpose limit from ADR 0002 decision 1 extends to both

Replay exists to show how people navigate and where they get stuck; retained conversations exist to show whether the assistant helps. Neither is a route to a user's work. No workflow — support, debugging, curiosity — may use replay to inspect a project's music or the conversation store to read a particular person's chats. This is a rule about what we do, and unlike ADR 0002 decision 2 it is not enforced by the shape of the data, which is precisely why it is written down.

### 5. The disclosure's promise is corrected, because it is no longer true

ADR 0002 decision 5 required that "Your music never leaves your project" remain literally true, and its decision 2 — canvas off — is what made it so. Decision 1 above ends that. Continuing to show the old copy would be a false statement to users, not a wording nicety.

The disclosure is revised to state accurately: sampled recordings may include the arrangement and piano roll — the musical work itself — and are used only to understand how the app is used; assistant conversations are stored to improve the assistant; names and typed text are masked; and declining telemetry stops both. Final wording remains `DEC-009`'s and ships through `HARD-006`, but the constraint is now that the copy must be *true*, not that it must preserve a particular sentence.

## Consequences

### What this buys

- Replay becomes useful for the surfaces that matter. Clip-edge dragging, note entry, and arrangement navigation are observable rather than blank.
- The assistant becomes evaluable. What people actually ask, and which replies they abandon, is answerable from data we hold — and answerable as text, which replay could never have provided.
- The third-party surface does not grow in the dimension that matters most. Free-form user text still stops at our boundary.

### What this costs, and what we do about it

- **The user's music is now in a third-party system, in sampled recordings.** This is the substantive cost and there is no mitigation that removes it — only sampling (ADR 0002 decision 6 unchanged), a corrected disclosure (decision 5), the opt-out, and the purpose limit (decision 4). If that trade stops looking worth it, the reversal is one flag: `canvas: false`.
- **We now hold a corpus of free-form user text.** Assistant prompts attract personal context that a track name never would. Decision 3's obligations are the whole safeguard, and unlike masking they are not enforced by the capture mechanism — they need rules, tests, and review to stay real.
- **Canvas replay is bandwidth- and quota-heavy.** Canvas recording produces substantially larger payloads than DOM replay. The ADR 0002 decision 6 session sample rate is now more likely to need lowering, and `OPS-001` measures quota consumption with canvas enabled before the rate is trusted.
- **The section 10 bundle budget is under more pressure.** Canvas replay adds to the already-large replay integration. ADR 0002 decision 8's lazy-load rule is unchanged and a budget regression remains a reason to reduce sampling or drop replay.
- **`DEC-009` grows.** It must now settle retention and region for the conversation store as well as for events, errors, and replays — and a corpus of user text plausibly deserves a shorter retention than any of them.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Keep canvas off (ADR 0002 as written) | Leaves replay blind in exactly the surfaces where users get stuck; the instrument fails at its stated purpose |
| Unmask the assistant panel in replay instead of first-party retention | Sends free-form user text to a third-party processor, sampled and unqueryable — strictly worse for both privacy and usefulness than storing it ourselves |
| Capture canvas but at a much lower sample rate than DOM replay | Sentry does not expose independent rates per surface; the effective control is the single session rate, which decision 6 already governs |
| Retain assistant conversations without the opt-out, as "operational" data | Product analysis is exactly what the telemetry opt-out covers; carving it out would make the opt-out mean less than users are told it means |
| Synthesise the assistant signal from acceptance/rejection events only | Cheaper and lower-risk, and worth having regardless — but it says whether a reply landed, never why it missed, which is the question |

## Revisit when

- `OPS-001` measures replay quota and bundle cost with canvas enabled; either may force the sample rate down or the decision back.
- `DEC-009` settles retention, region, and consent for the conversation store.
- The assistant's design settles enough that acceptance/rejection events might answer the product question with less data than full transcripts.
- Public launch, where a larger cohort changes both the quota arithmetic and the privacy calculus for holding user text.
