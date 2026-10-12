# Assistant musical capability evals: summary

- Run: 2026-10-12T16:37:30.868Z
- Model: `claude-sonnet-5`
- Prompt version: `2026-10-12.5`
- Tool set version: 6
- Runs per case: 3; cases: 25; turns: 75; errored turns: 2

Pass rates count the proposals a check could judge. A reply with no proposal, or one that did not apply, fails check 1 and is not judged by checks 2 to 5 or 7. A turn that errored (the provider or the transport failed, or it timed out) is not judged by any check and is counted apart. Check 6 is judged on extreme cases only, and check 7 on the sketch cases only (the ones that name the parts they ask for). Check 8 judges every case: a proposal, or, where the case expects one, a question and no proposal; a case that expects a question is judged by checks 1 to 7 only if it proposed something anyway. Checks 9 to 13 are judged only on the cases that name them. Nothing gates on the descriptive numbers.

**Errored turns: 2 of 75**. They are not the model's answers, so no check judged them; each is listed under its run below.

## Headline

| Score | Value |
| --- | --- |
| Applies cleanly (check 1) | 80.0% (56/70) |
| Overall pass rate (every check) | 93.0% (388/417) |
| Expected outcome (check 8) | 95.9% (70/73) |
| Errored turns (judged by no check) | 2 of 75 |

## Cost of the score

Latency is over the turns that replied, first text over the turns that streamed any, tokens over the turns that recorded them; cost is estimated from the model's price in `ASSISTANT_MODELS`.

| Number | Value |
| --- | --- |
| Latency p50 / p95 | 18.4 s / 96.7 s (73 turns) |
| First text p50 / p95 | 10.9 s / 54.7 s (75 turns) |
| Input tokens per turn | 31,547 |
| Output tokens per turn | 3,169 |
| Cache-read tokens per turn | 0 |
| Tokens in all (input / output / cache read / cache write) | 2,366,043 / 237,675 / 0 / 0 (75 turns) |
| Cost per turn / of the run | $0.0948 / $7.1088 |
| Stop reasons | tool_use 73, max_tokens 2 |
| Cut off at max_tokens / refused | 2.7% / 0.0% |

## Pass rate per check

| Check | Pass rate |
| --- | --- |
| 1. Valid | 56/70 (80%) |
| 2. Editable, bundled sources only | 56/56 (100%, 14 not judged) |
| 3. In scope | 56/56 (100%, 14 not judged) |
| 4. Atomic undo | 56/56 (100%, 14 not judged) |
| 5. Grounded explanation | 56/56 (100%, 14 not judged) |
| 6. Extreme is not flattened | 11/11 (100%, 4 not judged) |
| 7. Covers the requested parts | 0/3 (0%, 67 not judged) |
| 8. Expected outcome | 70/73 (96%) |
| 9. Denser hats, nothing else | 3/3 (100%) |
| 10. Points to the Generate panel | 0/3 (0%) |
| 11. Develops the loop into a track | 0/1 (0%) |
| 12. A sparse, slow pad | 0/0 (n/a, 3 not judged) |
| 13. Dissonant chords | 0/0 (n/a, 3 not judged) |
| 14. Adds tracks | 1/3 (33%, 3 not judged) |
| 15. A parameter ends at the exact value | 18/18 (100%) |
| 16. No clip left without notes | 0/3 (0%) |
| 17. No command sets a value to what it already is | 5/5 (100%, 1 not judged) |

## By case

| Case | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | Errored |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sketch-house` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/3 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `sketch-broken` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `variation-fill` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `variation-mangled` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `arrange-build-drop` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `arrange-no-build` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `balance-clean` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `balance-lopsided` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `process-glue` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `process-crushed` | 2/3 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `density-hats` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | 3/3 | 0/3 | - | - | - | - | - | - | - | 0 |
| `develop-track-ask` | - | - | - | - | - | - | - | 3/3 | - | - | - | - | - | - | - | - | - | 0 |
| `develop-track-arrange` | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | - | 0/0 | 1/1 | - | - | 0/1 | - | - | - | - | - | - | 2 |
| `pad-genre-known` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 3/3 | - | - | - | 0/0 | 0/0 | - | - | - | - | 0 |
| `pad-genre-unknown` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | - | - | 0 |
| `sketch-whole-song` | 2/3 | 2/2 | 2/2 | 2/2 | 2/2 | - | 0/0 | 3/3 | - | - | - | - | - | 0/2 | - | - | - | 0 |
| `sketch-track-scope` | 1/3 | 1/1 | 1/1 | 1/1 | 1/1 | - | 0/0 | 3/3 | - | - | - | - | - | 1/1 | - | - | - | 0 |
| `db-nudge-down` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | - | - | 0 |
| `db-turn-down` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | - | - | 0 |
| `db-lower` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | - | - | 0 |
| `db-turn-up` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | - | - | 0 |
| `db-stale-cancelled` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | - | - | 0 |
| `db-stale-undone` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | - | - | 0 |
| `resketch-extreme` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 0/3 | 3/3 | 0 |
| `noop-bd-only` | 2/3 | 2/2 | 2/2 | 2/2 | 2/2 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | - | 2/2 | 0 |

## Cost by case

| Case | Turns | Latency p50 | p95 | First text p50 | Input tok | Output tok | Cache read tok | Cost/turn | Stop reasons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sketch-house` | 3 | 44.2 s | 54.8 s | 43.6 s | 31,084 | 4,013 | 0 | $0.1023 | tool_use 3 |
| `sketch-broken` | 3 | 100.7 s | 101.2 s | 46.7 s | 31,105 | 12,470 | 0 | $0.1869 | tool_use 3 |
| `variation-fill` | 3 | 33.5 s | 45.3 s | 17.1 s | 32,759 | 4,180 | 0 | $0.1073 | tool_use 3 |
| `variation-mangled` | 3 | 29.8 s | 35.4 s | 17.0 s | 32,748 | 3,317 | 0 | $0.0987 | tool_use 3 |
| `arrange-build-drop` | 3 | 51.9 s | 60.8 s | 41.0 s | 34,495 | 5,152 | 0 | $0.1205 | tool_use 3 |
| `arrange-no-build` | 3 | 48.2 s | 49.8 s | 30.4 s | 34,501 | 5,404 | 0 | $0.1230 | tool_use 3 |
| `balance-clean` | 3 | 11.6 s | 15.5 s | 4.6 s | 31,589 | 1,307 | 0 | $0.0762 | tool_use 3 |
| `balance-lopsided` | 3 | 7.9 s | 8.4 s | 2.8 s | 31,578 | 778 | 0 | $0.0709 | tool_use 3 |
| `process-glue` | 3 | 4.7 s | 4.7 s | 0.8 s | 31,562 | 409 | 0 | $0.0672 | tool_use 3 |
| `process-crushed` | 3 | 8.4 s | 9.3 s | 3.9 s | 31,572 | 713 | 0 | $0.0703 | tool_use 3 |
| `density-hats` | 3 | 23.8 s | 25.3 s | 12.3 s | 35,438 | 2,711 | 0 | $0.0980 | tool_use 3 |
| `develop-track-ask` | 3 | 10.4 s | 14.8 s | 5.3 s | 30,957 | 839 | 0 | $0.0703 | tool_use 3 |
| `develop-track-arrange` | 3 | 84.9 s | 84.9 s | 128.4 s | 31,221 | 13,725 | 0 | $0.1997 | max_tokens 2, tool_use 1 |
| `pad-genre-known` | 3 | 15.9 s | 25.0 s | 9.2 s | 30,997 | 1,690 | 0 | $0.0789 | tool_use 3 |
| `pad-genre-unknown` | 3 | 18.7 s | 23.5 s | 10.3 s | 30,944 | 1,895 | 0 | $0.0808 | tool_use 3 |
| `sketch-whole-song` | 3 | 52.1 s | 71.9 s | 39.2 s | 30,408 | 5,402 | 0 | $0.1148 | tool_use 3 |
| `sketch-track-scope` | 3 | 55.4 s | 96.7 s | 31.9 s | 30,945 | 7,646 | 0 | $0.1384 | tool_use 3 |
| `db-nudge-down` | 3 | 3.1 s | 4.7 s | 1.8 s | 30,400 | 288 | 0 | $0.0637 | tool_use 3 |
| `db-turn-down` | 3 | 3.0 s | 3.2 s | 1.7 s | 30,397 | 281 | 0 | $0.0636 | tool_use 3 |
| `db-lower` | 3 | 2.9 s | 3.0 s | 1.5 s | 30,404 | 275 | 0 | $0.0636 | tool_use 3 |
| `db-turn-up` | 3 | 3.3 s | 6.2 s | 1.9 s | 30,396 | 286 | 0 | $0.0637 | tool_use 3 |
| `db-stale-cancelled` | 3 | 3.6 s | 3.9 s | 1.9 s | 30,444 | 312 | 0 | $0.0640 | tool_use 3 |
| `db-stale-undone` | 3 | 3.7 s | 4.1 s | 2.3 s | 30,439 | 291 | 0 | $0.0638 | tool_use 3 |
| `resketch-extreme` | 3 | 25.7 s | 44.5 s | 24.1 s | 31,890 | 2,511 | 0 | $0.0889 | tool_use 3 |
| `noop-bd-only` | 3 | 36.9 s | 55.5 s | 35.8 s | 30,409 | 3,332 | 0 | $0.0941 | tool_use 3 |
