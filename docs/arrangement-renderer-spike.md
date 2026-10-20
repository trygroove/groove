# Arrangement renderer spike and measurement harness (retired)

| Field | Value |
| --- | --- |
| Status | **Retired.** Implemented by `FND-008`; its disposable UI, its unlinked route, and its measurement harness were removed once the production arrangement renderer landed. |
| Scope | Historical record of what `FND-008` produced, which parts were retained, and where its baseline numbers came from. |

Related documents: [PRD performance budgets](./prd.md#performance-budgets), [testing](./testing.md). The arrangement renderer decision and its acceptance budgets were specified in PRD section 9.3, removed when the PRD became a principles document; that text is in git history, and the numbers this spike measured are recorded below.

`FND-008` built a deliberately disposable hybrid virtualized-DOM/Canvas 2D
spike to prove out the projection/geometry contracts under a real Canvas
renderer and to give a measurement harness something to drive. It was never
gated on hitting the PRD frame budgets — those bind at `ARR-005` (Alpha
Milestone 2) and `HARD-001` (Alpha Milestone 4) — and it was explicitly
expected to be *replaced, not grown*.

That replacement exists: `src/arrangement/ArrangementView.tsx`, built on the
retained contracts below. With the production renderer in place the spike's
own UI had no remaining consumer, so it was removed rather than left to rot
alongside the renderer that supersedes it.

## What was removed

| Path | Note |
| --- | --- |
| `src/arrangement/spike/` | The Canvas-drawing Solid component (`ArrangementSpike.tsx`), its layer-drawing code (`canvasLayers.ts`), its measurement instrumentation (`instrumentation.ts`), and its README. |
| `src/routes/spike/arrangement.tsx` | The unlinked `/spike/arrangement` route that mounted it. |
| `perf/arrangement.bench.spec.ts`, `playwright.bench.config.ts` | The scripted-trace harness and its Playwright config. Both drove the spike route exclusively and could not outlive it unchanged. |
| `.github/workflows/bench-arrangement.yml` | The `workflow_dispatch` job that produced the checked-in baseline on CI. |
| `bun run bench:arrangement` | The npm script pair (`prebench:arrangement`/`bench:arrangement`). |

Git history remains the full record; every file above is recoverable from the
commit that removed it.

## What was retained

These have no DOM/Canvas/SolidJS imports and are the renderer-agnostic
contracts the production renderer uses today:

| Path | Why |
| --- | --- |
| `src/arrangement/geometry.ts` | Pure viewport/row/zoom math (PRD 9.3 "Viewport and scrolling model"). |
| `src/arrangement/projection.ts` | Builds the `ArrangementProjection` PRD 9.3 calls for: stable IDs, integer musical bounds, track order, colors, labels, compact preview data, revision counters, viewport culling, hit testing. |
| `src/projection/revision.ts` | Object-identity revision counters — cheap because domain state is edited immutably (the command layer rebuilds with structural sharing), so reference equality already tells you what changed. |
| `src/arrangement/waveformCache.ts` | LRU, multi-resolution, keyed by `(assetId, revision)`, budgeted at the PRD's `128 MiB`. `generateSyntheticPeaks` is the one piece a real audio-decode pipeline replaces later. |

## Retained fixtures

`src/domain/fixtures.ts` still provides the large-arrangement fixtures the
spike introduced, because the production renderer's own unit tests
(`ArrangementView.test.tsx`, `canvasRenderer.test.ts`,
`arrangementShell.test.ts`, `projection.test.ts`) all drive them:

- `createReferenceProject({ waveformTrackCount, ... })` — the PRD 9.3
  reference-arrangement fixture (50 tracks, ten minutes, 2,500 placements, 100
  automation lanes by default). `waveformTrackCount` turns that many tracks
  into `audio` tracks holding an `audioLoop` clip, so waveform-preview
  placements get coverage too. Defaults to `0`.
- `createLargeArrangementProject(trackCount)` — a benchmark fixture at `20`,
  `40`, or `50` tracks (`ARRANGEMENT_BENCHMARK_TRACK_COUNTS`), each a
  ten-minute arrangement with `50 × trackCount` placements (matching the PRD
  9.3 reference arrangement's per-track density, so the 50-track case reaches
  "at least 2,500 clip placements"), `2 × trackCount` automation lanes, and
  ~40% of tracks as waveform-bearing audio tracks. Deterministic and validated
  by `parseProject`.
- `createLargeArrangementFixtures()` — all three, keyed by track count.

These were named `createArrangementSpikeProject` /
`createArrangementSpikeFixtures` / `ARRANGEMENT_SPIKE_TRACK_COUNTS` while the
spike owned them. Their **seed literals are deliberately unchanged** by that
rename: the seed determines every generated ID and placement, so editing it
would silently reshape every fixture these tests assert against.

## The `FND-008` baseline (historical)

`docs/perf/arrangement-spike-baseline.json` is kept as milestone evidence. It
is the honest record of what the spike measured, and the PRD's Alpha Milestone
0 exit criteria name it directly — deleting it would erase that trail.

Recorded on: Linux x64, AMD EPYC 9V74 80-Core Processor (GitHub Actions
`ubuntu-latest` runner, 4 vCPUs allotted, 15.6 GiB RAM), Chromium
151.0.7922.34. This is **not** the PRD 9.3 physical baseline device (a 2019
13-inch Intel MacBook Pro class machine, 8 GB RAM, integrated graphics) —
that device binds at `ARR-005`/`HARD-001`. Per PRD 9.3's own instruction,
"Measuring a spike on unrepresentative hardware and declaring the budget met
is a worse outcome than an honest early number," the numbers were recorded
exactly as measured. All twelve traces landed at or near the ~16.7 ms vsync
cadence with p95 no higher than ~17.2 ms and zero long tasks — which reads as
"the harness ran correctly end-to-end and produced sane numbers," **not** as
evidence that the PRD 9.3 budgets are met.

Because those numbers describe the retired spike renderer, they are not a
baseline for the production renderer and must not be compared against it.

## Measuring the production renderer

There is currently **no arrangement performance harness.** Removing the spike
removed the only one, and repointing it at `ArrangementView` requires
instrumentation the production component does not yet have: per-frame redraw
recording, a scripted-trace driver, and an imperative handle for a harness to
drive.

Standing that back up against the production renderer is tracked separately.
The PRD 9.3 budgets bind at `ARR-005` and `HARD-001`, so a harness must exist
again before either can be assessed.
