# Assistant basic production actions evals: baseline

**Not recorded yet.** This set (GRV-119, `src/assistant/evals/basicActionCases.ts`) landed without a live run: the environment that built it had no `ANTHROPIC_API_KEY`, and no number here may be made up. Until a run replaces this page there is no baseline for the set, and the musical baseline (`docs/assistant-eval-baseline.md`) does not cover it.

## How to record it

1. Run the set 3 times per case on the production model, against the live model:
   - locally, with `ANTHROPIC_API_KEY` set: `bun run assistant:eval -- --set basicActions --out tmp/assistant-evals/basic-actions`;
   - or from the Actions tab: **Assistant evals** (`.github/workflows/eval-assistant.yml`), with the set's case IDs (`bun run assistant:eval -- --help` lists them; they all start `basic-`) in the cases box. Its artifact carries the summary files.
2. Commit the run's `summary.md` over this page, and its `summary.json` beside it as `docs/assistant-eval-baseline-basic-actions.json`. Both name the run's date, model and prompt version.
3. Compare a later change against it with `bun run assistant:eval -- --set basicActions --baseline docs/assistant-eval-baseline-basic-actions.json`.

## What to expect on the first run

Seven cases ask for what the assistant cannot do yet, because no tool makes the edit or the project description it is sent (`buildAssistantPayload`, `src/assistant/payload.ts`) leaves out an ID the edit needs. They should fail until it can, and are kept so the score shows it:

- `basic-loop-bars` (case 5, "Loop bars 5–8"): no assistant tool sets the song's loop range.
- `basic-longer-kick` (case 13, "Pick a longer kick sample"): `drum_setPadAsset` only points a pad at a sound already in the project, and the description sends none of the project's sounds (a pad goes out as its ID and name, with no asset ID or duration). The kit holds no longer kick either, and no tool brings one in from the library.
- `basic-add-clap` (case 14, "Add a clap to the drum machine"): no assistant tool adds a pad (`drum.addPad` is outside the alpha capability set), and the clap's asset ID is not in the description.
- `basic-remove-reverb` (case 18, "Take the reverb off again"): `device_remove` needs the reverb's device ID, and the description sends only each track's `deviceCount`.
- `basic-wetter-reverb` (case 19, "Make the reverb wetter"): `parameter_set` at `trackDevice` scope needs the device ID, which the description does not send.
- `basic-delay-before-reverb` (case 20, "Put the delay before the reverb"): `device_reorder` needs the delay's device ID, which the description does not send.
- `basic-key` (case 28, "Change the key to A minor"): no assistant tool sets the song's key.
