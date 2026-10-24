# ADR 0007 - What the assistant sends off-platform, and what we tell users about it

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-27 |
| Decides | Which parts of a user's project may be sent to the AI provider, and the disclosure copy that describes it |
| Supersedes | The draft disclosure copy in `AI-006` ([#95](https://github.com/trygroove/groove/issues/95)), including its "no notes, no project contents beyond the project ID" claim |
| Amended | 2026-10-12 by GRV-97: retention moves from opt-in to opt-out (decision 9) |
| Amended | 2026-10-24 by GRV-205: the disclosure is available before the first message, not answered before it (decisions 5 and 9) |
| Affects | `DEC-005` ([#34](https://github.com/trygroove/groove/issues/34)), `AI-006` ([#95](https://github.com/trygroove/groove/issues/95)), `AI-001` ([#69](https://github.com/trygroove/groove/issues/69)), `src/projection/assistantContextProjection.ts`, `src/projection/projectAnalysisProjection.ts` |

## Context

[ADR 0006](./0006-anthropic-behind-a-model-agnostic-gateway.md) settles which provider the assistant calls and what it may cost. This one settles what we hand that provider, and what we say about it.

Two terms were already recorded on `DEC-005` and are inherited here rather than reopened: assistant transcripts are retained first-party for **30 days**, and the alpha ships **no provider-level opt-out** — a user who does not want their prompts reaching the provider declines the assistant, which costs no manual DAW capability.

The projections that would carry the payload already exist. `assistantContextProjection.ts` sends the project name, tempo, time signature, track and section names, instrument kinds, device and clip counts, mixer state and the current selection; `projectAnalysisProjection.ts` adds derived facts — pitch range, mean velocity, notes per bar, repetition ratio. **Neither sends a single note event.** That gap is not a detail: an assistant that can "add, remove, move, resize, and transform note events" cannot do any of it to material it has never seen. As built, the most-used half of the assistant's capability set was undeliverable.

[ADR 0003](./0003-replay-canvas-capture-and-assistant-conversation-retention.md) decision 5 established the standard this decision is held to: when a disclosure's promise stops being true, the copy is corrected rather than defended. That is what happens below.

## Decision

### 1. The off-platform payload is an allowlist

The assistant may be sent, for the project currently open:

- project name, tempo, swing, time signature, total length (swing added by GRV-5, so the assistant proposes a swing change from the song's current value);
- sections, with their names, positions and lengths;
- tracks, with their names, type, instrument kind, device/clip/placement counts, and mixer state, and a drum machine's pads by ID and name (GRV-23, so a recommended sound can name the pad it is for) with each pad's hit count across the track's clips (GRV-122, a derived statistic, so "the hi-hats" is found as a pad with nothing selected), and each placement's ID, clip ID, start, length and whether it loops (GRV-6, so a new clip is placed beside the existing ones rather than on top of them);
- derived note statistics — register, mean velocity, density, repetition;
- a description of the current selection;
- **raw note events for the current selection only**;
- the conversation so far, within the bound [ADR 0006](./0006-anthropic-behind-a-model-agnostic-gateway.md) decision 3 sets.
- the published library the app serves, so the assistant can recommend a pack and its sounds by ID (GRV-23): each pack's name, publisher, version, description and size, its sounds' names, roles and tags, and which of them the project already uses. These are library facts Groove ships, not user content. Never a sound's audio, URL or storage path, and never a producer's own packs, whose names are theirs.

Anything not on this list is not sent. Extending the list is a change to this ADR.

### 2. What never leaves, regardless

Audio of any kind. Note events outside the current selection. Asset URLs. Provider credentials or tokens. Account data beyond the pseudonymous identifier quota enforcement needs — no email address, no display name.

### 3. Raw notes are scoped to the selection, and that is what makes the capability deliverable

Sending the selection's notes is what lets the assistant edit notes at all. Scoping it to the selection is what keeps the exposure proportional: the material the user is actively working on goes, the rest of the project does not, and the payload does not grow without bound as the project does.

The track the editor has in the assistant's scope counts as selected (GRV-122): its clips' notes go, as a selected track's do, because that track is what the producer is pointing at and the scope chip names it.

Where the user has selected nothing and the scope is the whole song, the assistant receives the song-level summary and no note events, and says it lacks the context rather than inventing it.

### 4. User-entered names leave the platform, deliberately

Project, track and section names are free text a user typed, and they go to the provider verbatim. An assistant that cannot say "I turned the bass down" — only "I turned track_7f3a down" — is visibly worse at the one thing it is for.

This is a real cost and it is accepted rather than mitigated: a track named for a person, a label, or an unreleased collaboration goes off-platform along with everything else. What the decision requires instead is that the disclosure say so plainly, which the copy below does. Silently sending names while implying we do not is the outcome this rejects.

### 5. The disclosure copy is approved as follows

> **About the assistant**
>
> Groove sends Anthropic — the AI service behind the assistant — your message along with a description of the project you're working in: its name, your track and section names, the tempo and structure, your mixer settings, and the notes in whatever you currently have selected. It does not send your audio, and it does not send the rest of your project.
>
> Anthropic does not use anything we send it to train their AI models, and they delete it within 30 days — unless their automated safety systems flag something, in which case they can keep it for up to two years.
>
> Separately, Groove keeps your conversations — your messages, the assistant's replies, and the changes it proposes, including any notes it writes for you — for 30 days. Our goal is to make the assistant better. The team may read them. After 30 days they are deleted.
>
> ☑ Keep my conversations with the assistant for 30 days
> This controls Groove's own copy only. It does not take back anything already sent to Anthropic.
>
> The assistant behaves exactly the same either way, and every other part of Groove works without it — if you would rather nothing was sent, you can simply not use the assistant.

Decision 9 turns the control into a notice with a way out ("OK" / "Don't keep them") and adds "unless you tell it not to" to the third paragraph; GRV-126 adds a fourth paragraph saying a kept conversation also goes to PostHog ([ADR 0003](./0003-replay-canvas-capture-and-assistant-conversation-retention.md) decision 2, as amended), and widens the control's scope line to match. `src/editor/assistant/retentionCopy.ts` holds the current wording.

**Amended 2026-10-24 (GRV-205): available before the first message, not answered before it.** GRV-8 made the disclosure a gate: nobody could message the assistant until they had pressed a button under four paragraphs. A first-session tester read it as a wall of unfamiliar names ("what's Anthropic?") at the moment they wanted to try the thing. By product-owner decision the full text above is unchanged but no longer stands in front of the composer. The panel opens straight onto the conversation, with a one-line note under the composer: Groove sends your message and a description of your project to an AI service, and keeps your conversations for 30 days, with three plain buttons: **How this works** (opens the full text above, with its **OK** / **Don't keep them** notice and the scope line, in Coproducer settings, one tap away), **Don't keep my conversations** (opts out there and then, with the existing confirmation) and **Got it** (dismisses the note and stores the default, keeping, as the answer). The one-liner says "an AI service"; "Anthropic" stays in the full text, which must name the processor. The note stays until the producer taps one of its buttons or answers in the full text, and the answer is stored and remembered exactly as before. The full text is still in Coproducer settings and the footer's Privacy panel. Opening it from the note logs `feature_first_use` with `assistant_disclosure`. The welcome (`/welcome`) is unchanged: the note belongs to the panel. What may not change is the standard below: the four things stay reachable in one tap, and the opt-out stays as easy to find.

Wording stays tweakable without reopening this ADR; what may not change is that it remains true and specific about the same four things — what is sent, what the provider may do with it, what we keep and for how long, and what the control does and does not cover.

### 6. The provider-posture sentence is written from verified terms, and shipping it unverified is a defect

`AI-006` reads Anthropic's published terms on the day it ships, writes that one sentence from what they actually say, and cites what it read in its PR. Shipping the bracketed placeholder is a defect; so is shipping a posture claim nobody checked.

`DEC-005` recorded a *permission* — that the provider may retain and train on our requests — and permission is not knowledge. If the terms say Anthropic does not train on API traffic, then telling the cohort it might would be a false statement in the frightening direction, which fails ADR 0003 decision 5's standard exactly as a reassuring falsehood would.

**Verification record — 2026-08-27.** Read on that date:
[commercial terms](https://www.anthropic.com/legal/commercial-terms),
[privacy policy](https://www.anthropic.com/legal/privacy),
[commercial data retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-personal-data),
[API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).
Finding: the commercial terms state "Anthropic may not train models on Customer Content from Services," where Customer Content is defined as Inputs and Outputs together — so the no-training posture is a term of the standard commercial agreement our API access already falls under, not an enterprise upgrade or an opt-out we have to request. Inputs and outputs are deleted within 30 days by default; content flagged by automated trust-and-safety systems is retained up to 2 years. Zero-data-retention agreements shorten the default but do not change the training answer, which is already "no" without one. **This check does not discharge the standing requirement above:** the terms can change under us, so `AI-006` re-reads them on the day it ships and corrects the sentence if they have.

### 7. The `AI-006` draft copy's central claim is withdrawn

That draft told the user "Your music itself is not kept: no audio, no notes, and no clip or project contents beyond the ID of the project you were working in." It is false twice over. It is false about what is sent, under decisions 1 and 4. And it is false about our own store: `AI-006`'s record holds the proposals the assistant showed, and a proposal that writes a bassline **is** note data. The claim would have become untrue the first time the assistant did the thing it exists to do.

### 8. The opt-out's scope limit renders on the control, in both places it appears

The line stating that the control governs Groove's copy only travels with the control itself — in the first-run dialog and in the durable settings surface, which is where most users will meet it on day three rather than day one. A true statement that only appears where a skimming user will not read it is doing the work of a misleading one.

### 9. Keeping transcripts is the default, and the producer can opt out (amended 2026-10-12, GRV-97)

By product-owner decision, retention moves from opt-in to opt-out. Under GRV-8 a transcript was kept only after an explicit yes in the first-run dialog, so most turns, the product owner's own failing ones included, left nothing to read, and an invalid proposal could not be diagnosed after the fact. Now:

- A turn is kept when the account has no answer (including a first message sent before the note is answered, GRV-205), or a malformed or stale one. Only an explicit "don't keep" (`retain: false`, at any disclosure version) stops it (`permitsRetention` in `src/assistant/transcripts.ts`). Existing answers keep their meaning: a no stays no, a yes stays yes.
- Opting out is unchanged: it still deletes every kept record at once, and a turn racing it either lands first and is deleted or reads the new answer and is not written.
- (Superseded in part by GRV-205, see decision 5: the notice is no longer a gate before the first message; it is the full text behind the composer's note.) The first-run dialog becomes a notice: it says Groove keeps conversations for the retention window and the team may read them, with **OK** and **Don't keep them** side by side, and the scope line under them (decision 8). The setting is unchanged.
- `ASSISTANT_DISCLOSURE_VERSION` stays at 1. Bumping it would not turn any no into a keep, but it would show the notice again to accounts that already answered, and their answers are as true under the new default as they were under the old one.
- Declining telemetry does not exclude conversations from retention today ([ADR 0003](./0003-replay-canvas-capture-and-assistant-conversation-retention.md)'s "opt-out covers it" was never wired into `src/analytics/consent.ts`), and this decision changes nothing about that; the assistant's own opt-out is the control.

## Consequences

### What this buys

- The assistant can edit notes, which the assistant's alpha capability set assumed and the projections did not support.
- The exposure is bounded by something specific — an allowlist and a selection — rather than by "we send a summary."
- The disclosure describes what actually happens, including the parts that are not flattering, so the first cohort member who thinks about it does not find a gap between the copy and the payload.

### What this costs, and what we do about it

- **User-typed names reach a third party that may retain them.** No mitigation removes this; decision 4 accepts it and decision 5 discloses it. The alternative was an assistant that cannot name anything.
- **The payload grows with the selection.** Selecting an entire dense track sends every note in it. Bounded in practice by what a user can select and by [ADR 0006](./0006-anthropic-behind-a-model-agnostic-gateway.md) decision 3's history bound, but it is not a fixed ceiling.
- **The disclosure is longer than the draft it replaces.** Being specific about four things costs words, and a dialog people skim is a poor place to spend them. Decision 8 is the partial answer: the load-bearing sentence sits on the control.
- **One sentence of the copy cannot be written until someone reads the provider's terms**, which makes `AI-006` depend on an external document that can change under it.
- **The projections need extending**, and the note-event path needs its own test that nothing outside the selection is ever included.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Stats and names only, no raw notes | Exactly what ships today, and it makes the assistant's note editing undeliverable. The gap would have surfaced as a failed acceptance criterion late in the milestone rather than as a decision made in the open |
| Send the whole project's notes every turn | Best assistant quality; the payload grows without bound as the project does, and the material a user is not working on has no reason to leave |
| Strip user-entered names, send IDs only | Nothing a user typed leaves, and the assistant can no longer refer to anything by name. Degrades every single reply to protect a case that the disclosure can honestly describe instead |
| Keep the `AI-006` draft copy and its "no notes" line | It is false under decisions 1 and 4, and false about our own transcript store. ADR 0003 decision 5 settled that the copy gets corrected |
| Keep the conservative "may retain and train" line unverified | Ships without an external dependency, at the price of possibly telling the cohort something untrue. A frightening falsehood is not the safe end of the error bar |
| Add a provider-level opt-out now | Already deferred on `DEC-005` as `P2-005`, with `HARD-005` asking the cohort about it directly. Unparking it is that decision's to make, not this one's |

## Revisit when

- A user can import their own samples, at which point asset names stop being library facts we ship and become user content, exactly as [ADR 0003](./0003-replay-canvas-capture-and-assistant-conversation-retention.md) flagged for replay.
- `HARD-005` reports that the cohort does care about provider-level opt-out, which unparks `P2-005` and changes what the copy has to offer.
- Anthropic's published terms change, which changes decision 6's sentence and may change decision 1's calculus.
- The assistant needs project-wide note context to do something it cannot do scoped to the selection — a real finding, not a convenience, and it reopens decision 3.
- Public launch, where a larger and uninvited audience changes the privacy calculus for names.
