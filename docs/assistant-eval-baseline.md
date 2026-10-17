# Assistant musical capability evals: summary

- Run: 2026-10-17T19:48:14.049Z
- Model: `claude-sonnet-5`
- Prompt version: `2026-10-16.2`
- Tool set version: 8
- Runs per case: 3; cases: 57; turns: 171; errored turns: 0

Pass rates count the proposals a check could judge. A reply with no proposal, or one that did not apply, fails check 1 and is not judged by checks 2 to 5 or 7. A turn that errored (the provider or the transport failed, or it timed out) is not judged by any check and is counted apart. Check 6 is judged on extreme cases only, and check 7 on the sketch cases only (the ones that name the parts they ask for). Check 8 judges every case: a proposal, or, where the case expects one, a question and no proposal; a case that expects a question is judged by checks 1 to 7 only if it proposed something anyway. Checks 16 and 20 judge every proposal that applied, because a proposal that stops partway (notes cleared and never written, a clip made and never placed) applies cleanly and passes the rest; the other checks from 9 on are judged only on the cases that name them, and 18 and 19 judge the basic production actions. Nothing gates on the descriptive numbers.

## Headline

| Score | Value |
| --- | --- |
| Applies cleanly (check 1) | 81.9% (136/166) |
| Overall pass rate (every check) | 93.6% (1260/1346) |
| Expected outcome (check 8) | 80.7% (138/171) |
| Errored turns (judged by no check) | 0 of 171 |

## By set

| Set | Cases | Applies cleanly (check 1) | Overall pass rate | Expected outcome (check 8) | Errored turns |
| --- | --- | --- | --- | --- | --- |
| Musical capability | 25 | 95.9% (70/73) | 96.5% (610/632) | 92.0% (69/75) | 0 of 75 |
| Basic production actions | 32 | 71.0% (66/93) | 91.0% (650/714) | 71.9% (69/96) | 0 of 96 |

## Heavy set

The mean of each case's figure over the 8 heavy-output cases this run scored (`sketch-broken`, `sketch-house`, `develop-track-arrange`, `sketch-whole-song`, `sketch-track-scope`, `arrange-build-drop`, `arrange-no-build`, `density-hats`), every case weighing the same.

| Number | Value |
| --- | --- |
| Mean output tokens per turn | 9,865 |
| Mean latency p50 | 89.4 s |
| Mean cost per turn | $0.1610 |

## Cost of the score

Latency is over the turns that replied, first text over the turns that streamed any, tokens over the turns that recorded them; cost is estimated from the model's price in `ASSISTANT_MODELS`.

| Number | Value |
| --- | --- |
| Latency p50 / p95 | 6.2 s / 107.9 s (171 turns) |
| First text p50 / p95 | 3.5 s / 50.3 s (170 turns) |
| Input tokens per turn | 4 |
| Output tokens per turn | 2,179 |
| Cache-read tokens per turn | 58,078 |
| Tokens in all (input / output / cache read / cache write) | 664 / 372,553 / 9,931,416 / 740,944 (171 turns) |
| Cost per turn / of the run | $0.0442 / $7.5656 |
| Stop reasons | tool_use 154, end_turn 17 |
| Cut off at max_tokens / refused | 0.0% / 0.0% |

## Pass rate per check

| Check | Pass rate |
| --- | --- |
| 1. Valid | 136/166 (82%) |
| 2. Editable, bundled sources only | 136/136 (100%, 30 not judged) |
| 3. In scope | 133/136 (98%, 30 not judged) |
| 4. Atomic undo | 131/136 (96%, 30 not judged) |
| 5. Grounded explanation | 136/136 (100%, 30 not judged) |
| 6. Extreme is not flattened | 15/15 (100%) |
| 7. Covers the requested parts | 6/6 (100%, 160 not judged) |
| 8. Expected outcome | 138/171 (81%) |
| 9. Denser hats, nothing else | 3/3 (100%) |
| 10. Points to the Generate panel | 0/3 (0%) |
| 11. Develops the loop into a track | 0/2 (0%, 1 not judged) |
| 12. A sparse, slow pad | 1/3 (33%) |
| 13. Dissonant chords | 0/3 (0%) |
| 14. Adds tracks | 6/6 (100%) |
| 15. A parameter ends at the exact value | 18/18 (100%) |
| 16. No clip left without notes | 133/133 (100%, 30 not judged) |
| 17. No command sets a value to what it already is | 4/5 (80%, 1 not judged) |
| 18. Makes the exact edit asked for | 65/66 (98%, 27 not judged) |
| 19. Nothing else changed | 63/66 (95%, 27 not judged) |
| 20. Every new clip is placed | 136/136 (100%, 30 not judged) |

## By case

| Case | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | Errored |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sketch-house` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 3/3 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `sketch-broken` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `variation-fill` | 2/3 | 2/2 | 2/2 | 2/2 | 2/2 | - | 0/0 | 2/3 | - | - | - | - | - | - | - | 2/2 | - | - | - | 2/2 | 0 |
| `variation-mangled` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `arrange-build-drop` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `arrange-no-build` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `balance-clean` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `balance-lopsided` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `process-glue` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `process-crushed` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `density-hats` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | 3/3 | 0/3 | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `develop-track-ask` | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | - | 0/0 | 2/3 | - | - | - | - | - | - | - | 1/1 | - | - | - | 1/1 | 0 |
| `develop-track-arrange` | 2/3 | 2/2 | 2/2 | 2/2 | 2/2 | - | 0/0 | 2/3 | - | - | 0/2 | - | - | - | - | 2/2 | - | - | - | 2/2 | 0 |
| `pad-genre-known` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | 1/3 | 0/3 | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `pad-genre-unknown` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 3/3 | - | - | - | 3/3 | 0 |
| `sketch-whole-song` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | 3/3 | - | 3/3 | - | - | - | 3/3 | 0 |
| `sketch-track-scope` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | 3/3 | - | 3/3 | - | - | - | 3/3 | 0 |
| `db-nudge-down` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | 3/3 | - | - | - | 3/3 | 0 |
| `db-turn-down` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | 3/3 | - | - | - | 3/3 | 0 |
| `db-lower` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | 3/3 | - | - | - | 3/3 | 0 |
| `db-turn-up` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | 3/3 | - | - | - | 3/3 | 0 |
| `db-stale-cancelled` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | 3/3 | - | - | - | 3/3 | 0 |
| `db-stale-undone` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | 3/3 | 3/3 | - | - | - | 3/3 | 0 |
| `resketch-extreme` | 2/3 | 2/2 | 2/2 | 0/2 | 2/2 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 2/2 | 2/2 | - | - | 2/2 | 0 |
| `noop-bd-only` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | 2/3 | - | - | 3/3 | 0 |
| `basic-extend-loop` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-duplicate-chorus` | 2/3 | 2/2 | 0/2 | 2/2 | 2/2 | - | 0/0 | 2/3 | - | - | - | - | - | - | - | 2/2 | - | 2/2 | 0/2 | 2/2 | 0 |
| `basic-trim-drums` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-move-bass` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-loop-bars` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 0/0 | - | 0/0 | 0/0 | 0/0 | 0 |
| `basic-delete-pad` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-add-synth` | 2/3 | 2/2 | 2/2 | 2/2 | 2/2 | - | 0/0 | 2/3 | - | - | - | - | - | - | - | 2/2 | - | 2/2 | 2/2 | 2/2 | 0 |
| `basic-add-drum-machine` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-rename-track` | 2/3 | 2/2 | 1/2 | 2/2 | 2/2 | - | 0/0 | 2/3 | - | - | - | - | - | - | - | 2/2 | - | 1/2 | 1/2 | 2/2 | 0 |
| `basic-mute-hats` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-solo-bass` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-vocals-to-top` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-kick-down` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-pan-guitar` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-longer-kick` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 0/0 | - | 0/0 | 0/0 | 0/0 | 0 |
| `basic-add-clap` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 0/0 | - | 0/0 | 0/0 | 0/0 | 0 |
| `basic-synth-to-sampler` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-lower-cutoff` | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-add-reverb` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-remove-reverb` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 0/0 | - | 0/0 | 0/0 | 0/0 | 0 |
| `basic-wetter-reverb` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 0/0 | - | 0/0 | 0/0 | 0/0 | 0 |
| `basic-delay-before-reverb` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 0/0 | - | 0/0 | 0/0 | 0/0 | 0 |
| `basic-reverb-send` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-quantize-hats` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-transpose-melody` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-humanize-hats` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-double-speed` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 0/0 | - | 0/0 | 0/0 | 0/0 | 0 |
| `basic-clear-clip` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | - | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-tempo` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-key` | 0/3 | 0/0 | 0/0 | 0/0 | 0/0 | - | 0/0 | 0/3 | - | - | - | - | - | - | - | 0/0 | - | 0/0 | 0/0 | 0/0 | 0 |
| `basic-undo` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | - | 0/0 | 3/3 | - | - | - | - | - | - | - | 3/3 | - | 3/3 | 3/3 | 3/3 | 0 |
| `basic-missing-track` | - | - | - | - | - | - | - | 3/3 | - | - | - | - | - | - | - | - | - | - | - | - | 0 |

## Cost by case

| Case | Turns | Latency p50 | p95 | First text p50 | Input tok | Output tok | Cache read tok | Cost/turn | Stop reasons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sketch-house` | 3 | 107.9 s | 108.2 s | 50.3 s | 12 | 12,308 | 176,043 | $0.2606 | tool_use 3 |
| `sketch-broken` | 3 | 116.3 s | 132.2 s | 52.4 s | 9 | 14,806 | 164,477 | $0.2220 | tool_use 3 |
| `variation-fill` | 3 | 35.9 s | 36.0 s | 19.2 s | 3 | 3,143 | 48,677 | $0.0551 | tool_use 3 |
| `variation-mangled` | 3 | 33.3 s | 34.5 s | 15.8 s | 5 | 3,524 | 69,998 | $0.0659 | tool_use 3 |
| `arrange-build-drop` | 3 | 64.5 s | 74.7 s | 43.1 s | 9 | 6,909 | 150,164 | $0.1302 | tool_use 3 |
| `arrange-no-build` | 3 | 59.8 s | 60.2 s | 34.6 s | 3 | 6,588 | 38,909 | $0.0917 | tool_use 3 |
| `balance-clean` | 3 | 13.6 s | 15.5 s | 7.2 s | 3 | 1,370 | 37,940 | $0.0269 | tool_use 3 |
| `balance-lopsided` | 3 | 6.6 s | 6.7 s | 0.7 s | 2 | 713 | 27,974 | $0.0175 | tool_use 3 |
| `process-glue` | 3 | 5.2 s | 5.3 s | 0.7 s | 3 | 420 | 47,885 | $0.0190 | tool_use 3 |
| `process-crushed` | 3 | 6.4 s | 6.6 s | 0.7 s | 3 | 594 | 37,933 | $0.0187 | tool_use 3 |
| `density-hats` | 3 | 56.7 s | 59.1 s | 23.5 s | 4 | 5,779 | 61,719 | $0.0992 | tool_use 3 |
| `develop-track-ask` | 3 | 7.0 s | 72.9 s | 0.8 s | 6 | 2,755 | 94,547 | $0.0558 | tool_use 3 |
| `develop-track-arrange` | 3 | 125.2 s | 158.2 s | 85.8 s | 5 | 11,401 | 75,247 | $0.1554 | tool_use 2, end_turn 1 |
| `pad-genre-known` | 3 | 19.7 s | 24.9 s | 9.1 s | 6 | 2,194 | 88,075 | $0.0483 | tool_use 3 |
| `pad-genre-unknown` | 3 | 17.0 s | 23.2 s | 0.7 s | 7 | 1,792 | 107,644 | $0.0473 | tool_use 3 |
| `sketch-whole-song` | 3 | 96.5 s | 114.8 s | 42.0 s | 10 | 10,859 | 164,165 | $0.1699 | tool_use 3 |
| `sketch-track-scope` | 3 | 88.2 s | 114.6 s | 44.1 s | 9 | 10,270 | 141,974 | $0.1588 | tool_use 3 |
| `db-nudge-down` | 3 | 3.1 s | 3.1 s | 1.7 s | 2 | 291 | 27,974 | $0.0103 | tool_use 3 |
| `db-turn-down` | 3 | 3.3 s | 3.8 s | 1.9 s | 3 | 284 | 37,544 | $0.0123 | tool_use 3 |
| `db-lower` | 3 | 2.9 s | 3.3 s | 0.7 s | 3 | 260 | 37,540 | $0.0121 | tool_use 3 |
| `db-turn-up` | 3 | 3.1 s | 3.8 s | 1.7 s | 3 | 283 | 37,544 | $0.0123 | tool_use 3 |
| `db-stale-cancelled` | 3 | 3.9 s | 4.6 s | 2.0 s | 3 | 300 | 47,141 | $0.0148 | tool_use 3 |
| `db-stale-undone` | 3 | 6.1 s | 7.0 s | 4.3 s | 3 | 353 | 47,140 | $0.0153 | tool_use 3 |
| `resketch-extreme` | 3 | 49.8 s | 53.0 s | 27.5 s | 7 | 4,851 | 114,135 | $0.0904 | tool_use 3 |
| `noop-bd-only` | 3 | 38.6 s | 58.6 s | 26.4 s | 7 | 4,155 | 99,033 | $0.0740 | tool_use 3 |
| `basic-extend-loop` | 3 | 4.6 s | 5.6 s | 3.1 s | 3 | 425 | 37,885 | $0.0165 | tool_use 3 |
| `basic-duplicate-chorus` | 3 | 30.5 s | 36.6 s | 24.1 s | 3 | 2,404 | 47,921 | $0.0440 | tool_use 3 |
| `basic-trim-drums` | 3 | 5.9 s | 6.2 s | 3.9 s | 3 | 480 | 47,924 | $0.0199 | tool_use 3 |
| `basic-move-bass` | 3 | 5.3 s | 6.1 s | 3.3 s | 3 | 439 | 47,924 | $0.0195 | tool_use 3 |
| `basic-loop-bars` | 3 | 5.9 s | 6.8 s | 4.0 s | 2 | 559 | 27,974 | $0.0160 | tool_use 3 |
| `basic-delete-pad` | 3 | 3.3 s | 4.5 s | 1.9 s | 3 | 279 | 38,237 | $0.0177 | tool_use 3 |
| `basic-add-synth` | 3 | 5.8 s | 5.9 s | 0.9 s | 3 | 485 | 48,502 | $0.0223 | tool_use 3 |
| `basic-add-drum-machine` | 3 | 15.3 s | 15.3 s | 6.9 s | 4 | 1,475 | 58,762 | $0.0369 | tool_use 3 |
| `basic-rename-track` | 3 | 6.4 s | 9.1 s | 4.6 s | 3 | 551 | 48,502 | $0.0228 | tool_use 3 |
| `basic-mute-hats` | 3 | 2.9 s | 3.6 s | 0.9 s | 3 | 253 | 38,233 | $0.0174 | tool_use 3 |
| `basic-solo-bass` | 3 | 3.2 s | 3.2 s | 1.8 s | 2 | 285 | 27,974 | $0.0155 | tool_use 3 |
| `basic-vocals-to-top` | 3 | 3.8 s | 3.8 s | 1.8 s | 4 | 268 | 58,759 | $0.0219 | tool_use 3 |
| `basic-kick-down` | 3 | 3.3 s | 4.3 s | 1.8 s | 3 | 298 | 38,237 | $0.0179 | tool_use 3 |
| `basic-pan-guitar` | 3 | 3.9 s | 4.1 s | 2.3 s | 2 | 335 | 27,974 | $0.0160 | tool_use 3 |
| `basic-longer-kick` | 3 | 2.1 s | 2.2 s | 0.7 s | 2 | 88 | 27,974 | $0.0109 | end_turn 3 |
| `basic-add-clap` | 3 | 13.0 s | 15.8 s | 12.8 s | 2 | 844 | 27,974 | $0.0160 | end_turn 2, tool_use 1 |
| `basic-synth-to-sampler` | 3 | 7.1 s | 7.1 s | 4.1 s | 4 | 530 | 57,574 | $0.0219 | tool_use 3 |
| `basic-lower-cutoff` | 3 | 4.8 s | 5.2 s | 3.2 s | 3 | 407 | 37,689 | $0.0148 | tool_use 3 |
| `basic-add-reverb` | 3 | 5.1 s | 5.4 s | 1.0 s | 4 | 408 | 58,760 | $0.0237 | tool_use 3 |
| `basic-remove-reverb` | 3 | 9.5 s | 11.9 s | 8.6 s | 2 | 797 | 27,974 | $0.0207 | tool_use 2, end_turn 1 |
| `basic-wetter-reverb` | 3 | 9.3 s | 11.9 s | 6.8 s | 2 | 763 | 27,974 | $0.0162 | tool_use 3 |
| `basic-delay-before-reverb` | 3 | 5.8 s | 7.4 s | 4.1 s | 2 | 427 | 27,974 | $0.0128 | end_turn 2, tool_use 1 |
| `basic-reverb-send` | 3 | 8.4 s | 9.1 s | 3.5 s | 4 | 841 | 58,004 | $0.0263 | tool_use 3 |
| `basic-quantize-hats` | 3 | 4.6 s | 5.0 s | 2.2 s | 4 | 378 | 57,721 | $0.0205 | tool_use 3 |
| `basic-transpose-melody` | 3 | 4.4 s | 5.5 s | 3.6 s | 3 | 413 | 37,890 | $0.0164 | tool_use 3 |
| `basic-humanize-hats` | 3 | 7.7 s | 8.7 s | 3.9 s | 4 | 653 | 57,724 | $0.0239 | tool_use 3 |
| `basic-double-speed` | 3 | 11.3 s | 11.8 s | 11.2 s | 2 | 604 | 27,974 | $0.0161 | end_turn 3 |
| `basic-clear-clip` | 3 | 3.3 s | 3.7 s | 0.8 s | 4 | 231 | 58,338 | $0.0203 | tool_use 3 |
| `basic-tempo` | 3 | 3.0 s | 3.1 s | 1.5 s | 2 | 253 | 27,974 | $0.0130 | tool_use 3 |
| `basic-key` | 3 | 16.8 s | 21.9 s | 16.5 s | 2 | 1,265 | 27,974 | $0.0231 | end_turn 2, tool_use 1 |
| `basic-undo` | 3 | 3.8 s | 7.5 s | 1.8 s | 4 | 393 | 58,776 | $0.0233 | tool_use 3 |
| `basic-missing-track` | 3 | 2.3 s | 2.7 s | 2.3 s | 2 | 149 | 27,974 | $0.0141 | end_turn 3 |
