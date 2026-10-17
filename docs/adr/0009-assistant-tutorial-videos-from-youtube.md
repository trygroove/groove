# ADR 0009 - Assistant tutorial videos come from YouTube, with no allowlist

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-10-12 |
| Decides | Which tutorial videos the assistant may recommend, which provider and embedding surface plays them, and what loading one shares with that provider |
| Decided by | The product owner, on GRV-2 |
| Affects | GRV-16 (assistant tutorial video recommendations), the assistant's recommendation protocol in `src/assistant`, the assistant panel's video states (mocks `docs/design/mocks/07-*`) |

## Context

The north-star mocks show the assistant recommending a short tutorial video inline (`07-assistant-video.png`), playing it in the panel (`07-assistant-video-playing.png`) and fullscreen (`07-assistant-video-fullscreen.png`). The PRD names the problem it answers: tutorials explain techniques away from the user's actual project and interrupt the creative flow.

GRV-16 builds that, and was blocked on GRV-2 deciding three things an implementation would otherwise choose by default: which creators and videos are trusted and how one gets onto that list; which provider and embedding surface plays them; and what loading an external video shares, and with whom.

The original framing assumed a curated allowlist of trusted creators. A curated list needs someone to build it, review additions to it, and notice when a video on it is taken down or changes hands — ongoing editorial work the alpha has nobody for, gating a feature whose value is unproven.

## Decision

### 1. No allowlist for the alpha

The assistant may recommend any YouTube video. There is no list of trusted creators or approved videos, and no process for adding one.

- **Safety is delegated to YouTube's policies.** What YouTube allows to be published and embedded is what the assistant may show.
- **Quality is delegated to YouTube's ranking** and to the model's judgement of what fits the user's question.

The allowlisting criterion in GRV-2's original framing is withdrawn, not deferred to an implementation detail: GRV-16 builds no curation surface, admin tooling or creator data.

### 2. YouTube is the only provider, played through its embedded player

Videos play in YouTube's own embedded player (an `<iframe>`), the provider's supported surface, in its privacy-enhanced mode (`youtube-nocookie.com`). Groove never downloads, proxies, re-hosts or transcodes a video.

The embed stays what GRV-16 already requires it to be:

- **No autoplay.** A recommendation renders as a still card; nothing plays until the user presses play.
- **No interruption.** Playing a video does not stop, duck or reschedule Groove's transport or audio, and does not take keyboard focus away from editing until the user interacts with the player.
- **No project access.** The iframe is a separate origin and is given nothing from the project: no postMessage channel carrying project state, no URL parameters derived from it.
- **Failures are isolated.** A video that is removed, private, region-blocked, not embeddable or fails to load shows a contained error state in its card and affects nothing else in the panel or the editor.

### 3. Nothing reaches YouTube until the user asks for the video

A recommendation card renders from the video's ID, title and channel alone. The YouTube player — and with it any request to Google's servers — loads only when the user presses play on that card. A user who never plays a video sends YouTube nothing.

When they do press play, YouTube receives what any embedded player gets from a browser: the user's IP address, browser details, and the fact that this video was played on a Groove page. It receives no Groove account data and nothing from the project. Its handling of that is governed by Google's privacy policy, not ours.

### 4. What the assistant sends Anthropic does not change

Recommending a video needs nothing beyond what [ADR 0007](./0007-assistant-off-platform-context-and-disclosure.md) decision 1 already allows; this decision does not extend that allowlist. Video IDs and titles the assistant proposes are model output, not user content.

### 5. A recommended video must exist before it is shown

Because there is no curated list, the video ID comes from the model, and a model can name a video that does not exist, has been removed, or does not allow embedding. GRV-16 checks a recommended video is real and embeddable (for example through YouTube's oEmbed endpoint, which needs no API key) before it renders a card, and drops a recommendation that fails the check rather than showing a broken one. That check is made by Groove, not on the user's behalf from their browser, so it does not break decision 3.

**Amended 2026-10-13 (GRV-16 QA): the model names a search, not an ID.** In production the model almost never recalled an ID that exists, so every recommendation was dropped and no card ever showed. The model now gives a short search for the technique, and `assistantTurn` runs it through the YouTube Data API's search (embeddable videos only, strict SafeSearch) and shows the first result oEmbed still vouches for, with YouTube's title and channel. Both requests are Groove's, from the server, so decision 3 holds: the user's browser sends YouTube nothing until Play. What reaches Google is the model's search words and Groove's API key; the prompt keeps project names and the producer's own words out of the search. The search needs the `youtube.googleapis.com` API and a key in Secret Manager, and its free quota is about 100 searches a day; past it, videos are dropped as unchecked until the quota resets.

### 6. The disclosure says so, where the video is

The video card or player carries a short line saying the video plays from YouTube and that YouTube's terms and privacy policy apply when it does. Wording is GRV-16's to settle; what may not change is that it names YouTube and appears before or at the moment the user chooses to play.

## Consequences

### What this buys

- GRV-16 is unblocked with no editorial process, data model or admin surface to build first.
- The assistant can recommend whatever genuinely answers the question, not only what someone happened to list.
- A user who ignores videos shares nothing new with anyone.

### What this costs, and what we do about it

- **We do not vouch for what we show.** A recommended video may be poor, outdated, or from a creator we would not have chosen. YouTube's policies bound the worst case; the model's judgement bounds the typical one. The cohort's feedback is the check.
- **Model-named videos can be wrong.** Decision 5 catches the ones that do not exist or cannot embed; it cannot catch a real video that is off-topic. That is a model-quality problem, measured the way the assistant's other output is.
- **The validation check is a server-side dependency on YouTube.** If it is unavailable, recommendations are dropped, not shown unchecked.
- **Playing a video sends data to Google.** Decisions 3 and 6 make that the user's choice and say so; privacy-enhanced mode limits cookies until the user interacts with the player but does not make the request anonymous.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A curated allowlist of trusted creators | The original framing. Needs ongoing editorial work the alpha has no owner for, ahead of evidence anyone wants the feature |
| Link out to YouTube instead of embedding | No third-party iframe at all, and it sends the user away from their project, which is the problem the PRD names |
| Load the player as soon as a recommendation renders | Simpler, and it tells Google about every recommendation the user merely scrolled past |
| Several providers (Vimeo and others) | More embedding, validation and disclosure surface for no demonstrated need |
| Re-host or proxy videos | Rights and cost Groove has no reason to take on |

## Revisit when

- The cohort reports recommendations that are unsafe, low quality or off-topic often enough that YouTube's policies and the model's judgement are not a sufficient filter: reintroduce curation, starting from the channels the cohort rated well.
- Public launch, where a larger and uninvited audience changes what "we delegate to YouTube" costs.
- A second provider is wanted, or YouTube's embedding terms change.
- The day's search quota is regularly used up (the turn log's `videosUnchecked` climbing late in the day): ask Google for more, or cache searches.
