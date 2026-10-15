# ADR 0010 - Unparseable assistant tool input is refused, not repaired or retried

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-10-12 |
| Decides | What the assistant does when a tool call's streamed input does not parse as JSON |
| Decided by | The product owner, on GRV-92 |
| Affects | `src/assistant/streamEvents.ts` (`parseInput`), `src/assistant/proposal.ts` (`validateProposal`), `src/assistant/providerRequest.ts` (eager tool input streaming) |

## Context

Since GRV-6 the assistant's tools stream with `eager_input_streaming: true` (`providerRequest.ts`), so a large proposal arrives as it is written instead of after a long silence that trips the gateway's inactivity timeout. The cost of that setting is that the Messages API no longer validates tool input. A call whose input is not valid JSON reaches the gateway as text.

`streamEvents.ts` passes that text through unchanged, and `validateProposal` refuses it as `invalid_payload` (`(root): Invalid input: expected object, received string`). Nothing crashes and nothing is applied, but one malformed call throws away the whole proposal it belongs to. GRV-6's live eval lost a working compressor and saturator to one such call on `process-crushed`.

GRV-92 asked how often this happens and whether to (a) repair input that is only missing closing brackets, when the repaired JSON then passes the command's own schema, (b) retry the turn when a tool input does not parse, or (c) leave it.

### What was measured

Four full runs of the "Assistant evals" workflow (`claude-sonnet-5`, every case, 3 runs each), counting turns whose failure is `invalid_payload` with `expected object, received string`:

| Run | Turns | Unparseable tool input | Where |
| --- | --- | --- | --- |
| [38056635043](https://github.com/trygroove/groove/actions/runs/38056635043) | 30 | 1 | `process-crushed` |
| [38140366873](https://github.com/trygroove/groove/actions/runs/38140366873) | 30 | 2 | `process-crushed` ×2 |
| [38140720140](https://github.com/trygroove/groove/actions/runs/38140720140) | 30 | 2 | `process-crushed`, `variation-mangled` |
| [38141141758](https://github.com/trygroove/groove/actions/runs/38141141758) | 30 | 2 | `process-crushed` ×2 |
| **Total** | **120** | **7 (5.8%)** | 6 of 7 on `process-crushed` |

Over the three runs that make up GRV-92's 90-turn sample it is 6 in 90 (6.7%), and 5 of the 9 `process-crushed` turns. So it recurs, concentrated on one case.

The six calls from those three runs were 5 `device_add` and 1 `clip_create`. None was truncated: 3 had a `}` missing in the middle of the input, 2 had one `}` too many at the end, and 1 broke in the middle of its body.

## Decision

### 1. Unparseable tool input stays refused

`parseInput` keeps returning input that does not parse as the text it came as, and `validateProposal` keeps refusing it as `invalid_payload`. The proposal it belongs to is lost; the user sees the refusal, as for any other invalid call.

### 2. No repair

Groove does not edit a tool call's input to make it parse. Option (a) as specified, appending missing closing brackets, would have repaired none of the six measured calls, because none of them was cut short. Repairing what was measured means guessing where a brace belongs inside the input, and a guess that happens to pass the command's schema can still be a different change from the one the model meant. The rule that nothing applies a payload the command schema did not accept stands, and is not enough on its own to make a guessed repair safe.

### 3. No retry, for now

Groove does not re-run a turn when a tool input does not parse. Option (b) fits the failures that were measured, but it costs a second model call per occurrence, and it is a change to the gateway's turn handling that the measured rate does not yet justify.

## Consequences

### What this buys

- No new code path in the gateway or the proposal validator, and no change to what a refused proposal looks like.
- The invariant holds without exceptions: what is applied is exactly what the model sent, and the command schema accepted it.
- Eager input streaming stays on, so large proposals keep the inactivity timeout quiet.

### What this costs

- About one assistant turn in seventeen in the eval set loses its proposal to this, and on a processing request like `process-crushed` it is about half. A producer who hits it has to ask again.
- The eval report keeps counting these as failures, which is what keeps them visible.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| (a) Close unbalanced brackets, then validate | Fixed none of the measured cases; repairing them needs guessing where a brace goes inside the input |
| (b) Retry the turn when a tool input does not parse | Fits the measured cases, but a second model call and a gateway change the rate does not justify yet. The first choice if this is revisited |
| Turn eager input streaming off, so the API validates input | Brings back the long silences on large proposals that GRV-6 turned it on to fix |
| Apply the calls that parsed and drop the one that did not | A proposal is one coherent change; applying part of it gives the producer something the model did not propose |

## Revisit when

- The eval report, or the cohort, shows unparseable input on a meaningful share of real turns rather than one eval case: build (b), as its own card.
- A model or API change alters how often tool input breaks, or makes the API validate eagerly streamed input.
- The broken calls start to look like truncation, where (a)'s narrow repair would actually apply.
