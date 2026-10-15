# Assistant basic production actions evals: baseline

**Not recorded yet.** This set (GRV-119, `src/assistant/evals/basicActionCases.ts`) landed without a live run: the environment that built it had no `ANTHROPIC_API_KEY`, and no number here may be made up. Until a run replaces this page there is no baseline for the set, and the musical baseline (`docs/assistant-eval-baseline.md`) does not cover it.

## How to record it

1. Run the set 3 times per case on the production model, against the live model:
   - locally, with `ANTHROPIC_API_KEY` set: `bun run eval:assistant -- --set basicActions --out tmp/assistant-evals/basic-actions`;
   - or from the Actions tab: **Assistant evals** (`.github/workflows/eval-assistant.yml`), with the set's case IDs (`bun run eval:assistant -- --help` lists them; they all start `basic-`) in the cases box. Its artifact carries the summary files.
2. Commit the run's `summary.md` over this page, and its `summary.json` beside it as `docs/assistant-eval-baseline-basic-actions.json`. Both name the run's date, model and prompt version.
3. Compare a later change against it with `bun run eval:assistant -- --set basicActions --baseline docs/assistant-eval-baseline-basic-actions.json`.

## What to expect on the first run

Three cases ask for what the assistant's tools cannot do yet, so they should fail until it can, and are kept so the score shows it:

- `basic-loop-bars` (case 5, "Loop bars 5–8"): no assistant tool sets the song's loop range.
- `basic-key` (case 28, "Change the key to A minor"): no assistant tool sets the song's key.
- `basic-longer-kick` (case 13): the assistant can only point a pad at a sound already in the project, and the bundled factory library holds a single kick, so no longer kick is within its reach.
