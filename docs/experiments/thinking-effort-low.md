# Experiment `thinking-effort-low`: win

> Thinking at low effort writes the heavy sketches and arrangements in fewer output tokens, with no loss of quality.

- Card: GRV-110
- Verdict: **win**. `low` won on train and held there on the held-out cases.
- Winner: `low` (thinkingEffort=low)
- Goal: output tokens per turn (lower is better)
- Variants: `control` (production's defaults), `low` (thinkingEffort=low)
- Cases: the `heavyOutput` set: 5 train, 3 held out
- Guardrails: checks 1 and 8 within 3 points per set, the overall pass rate within 2, no case passing to failing in most runs, no rise in max_tokens stops or errored turns
- Model: `claude-sonnet-5`; prompt `2026-10-17.2`; tool set 9
- Commit: `c0aa4bfd60254a15db57a00161ef40c7ad4138d1`; run: https://github.com/trygroove/groove/actions/runs/39176053294
- Spend: $8.37 of a $25.00 budget
- Generated: 2026-10-18T23:29:56.569Z

## Train

5 train cases (`sketch-house`, `arrange-build-drop`, `density-hats`, `develop-track-arrange`, `sketch-whole-song`), 3 runs a case, 30 turns.

### `low` against the control: win

Tactics: thinkingEffort=low. Output tokens per turn improved, and every guardrail held.

- Goal: Output tokens per turn 9,161 to 6,070; per-case change -3,091 (95% interval -5,933 to -1,159 over 5 paired cases): **better**

| Guardrail | | Control to variant |
| --- | --- | --- |
| Applies cleanly (check 1) within 3 points in every set | pass | Musical capability 100.0% to 100.0% |
| Expected outcome (check 8) within 3 points in every set | pass | Musical capability 100.0% to 100.0% |
| Overall pass rate within 2 points | pass | 94.8% to 95.6% |
| No case goes from passing to failing in most runs | pass | none |
| No rise in max_tokens stops | pass | 0 of 15 turns to 0 of 15 |
| No rise in errored turns | pass | 0 of 15 turns to 0 of 15 |

#### Every number beside the control's

##### Musical capability

| Number | Variant | Control | Delta | |
| --- | --- | --- | --- | --- |
| Applies cleanly (check 1) | 100.0% | 100.0% | ±0.0 pp | same |
| Overall pass rate | 95.6% | 94.8% | +0.7 pp | better |
| Expected outcome (check 8) | 100.0% | 100.0% | ±0.0 pp | same |
| Errored turns | 0 | 0 | ±0 | same |
| Latency p50 | 52.6 s | 76.0 s | -23.4 s | better |
| Latency p95 | 116.5 s | 265.0 s | -148.5 s | better |
| First text p50 | 18.7 s | 40.7 s | -22.0 s | better |
| First text p95 | 62.6 s | 155.8 s | -93.2 s | better |
| Input tokens per turn | 9 | 9 | +1 | worse |
| Output tokens per turn | 6,070 | 9,161 | -3,091 | better |
| Cache-read tokens per turn | 145,040 | 143,709 | +1,331 | worse |
| Cost per turn | $0.1371 | $0.1753 | -$0.0381 | better |
| Cost of the run | $2.0569 | $2.6292 | -$0.5722 | better |
| Cut off at max_tokens | 0.0% | 0.0% | ±0.0 pp | same |
| Refused | 0.0% | 0.0% | ±0.0 pp | same |

##### Heavy set

| Number | Variant | Control | Delta | |
| --- | --- | --- | --- | --- |
| Mean output tokens per turn | 6,070 | 9,161 | -3,091 | better |
| Mean latency p50 | 56.1 s | 83.7 s | -27.6 s | better |
| Mean cost per turn | $0.1371 | $0.1753 | -$0.0381 | better |


## Held-out gate

3 held-out cases (`sketch-broken`, `arrange-no-build`, `sketch-track-scope`), 5 runs a case, 30 turns.

### Gate: `low` against the control: win

Tactics: thinkingEffort=low. Output tokens per turn improved, and every guardrail held.

- Goal: Output tokens per turn 8,757 to 6,126; per-case change -2,631 (95% interval -3,838 to -1,623 over 3 paired cases): **better**

| Guardrail | | Control to variant |
| --- | --- | --- |
| Applies cleanly (check 1) within 3 points in every set | pass | Musical capability 100.0% to 100.0% |
| Expected outcome (check 8) within 3 points in every set | pass | Musical capability 100.0% to 100.0% |
| Overall pass rate within 2 points | pass | 100.0% to 100.0% |
| No case goes from passing to failing in most runs | pass | none |
| No rise in max_tokens stops | pass | 0 of 15 turns to 0 of 15 |
| No rise in errored turns | pass | 0 of 15 turns to 0 of 15 |

#### Every number beside the control's

##### Musical capability

| Number | Variant | Control | Delta | |
| --- | --- | --- | --- | --- |
| Applies cleanly (check 1) | 100.0% | 100.0% | ±0.0 pp | same |
| Overall pass rate | 100.0% | 100.0% | ±0.0 pp | same |
| Expected outcome (check 8) | 100.0% | 100.0% | ±0.0 pp | same |
| Errored turns | 0 | 0 | ±0 | same |
| Latency p50 | 55.1 s | 78.5 s | -23.4 s | better |
| Latency p95 | 72.0 s | 124.5 s | -52.6 s | better |
| First text p50 | 19.1 s | 40.5 s | -21.5 s | better |
| First text p95 | 29.1 s | 75.8 s | -46.7 s | better |
| Input tokens per turn | 8 | 7 | +1 | worse |
| Output tokens per turn | 6,126 | 8,757 | -2,631 | better |
| Cache-read tokens per turn | 129,880 | 119,619 | +10,261 | worse |
| Cost per turn | $0.1098 | $0.1358 | -$0.0260 | better |
| Cost of the run | $1.6470 | $2.0369 | -$0.3899 | better |
| Cut off at max_tokens | 0.0% | 0.0% | ±0.0 pp | same |
| Refused | 0.0% | 0.0% | ±0.0 pp | same |

##### Heavy set

| Number | Variant | Control | Delta | |
| --- | --- | --- | --- | --- |
| Mean output tokens per turn | 6,126 | 8,757 | -2,631 | better |
| Mean latency p50 | 52.5 s | 77.5 s | -25.0 s | better |
| Mean cost per turn | $0.1098 | $0.1358 | -$0.0260 | better |
