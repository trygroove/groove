# ADR 0004 - Deepening a hot module means moving state, not moving lines

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-25 |
| Decides | What counts as a successful extraction from a composition root, and how it is measured |
| Affects | `REFACTOR-001` (#142), `REFACTOR-003`–`REFACTOR-006`, any future split of a hot module |

## Context

`REFACTOR-001` (#142) split `src/editor/composition/EditorView.tsx` into five modules. Its stated
motivation was merge-clash reduction: *"every parallel feature appends to this one
file, feature PRs collide on it even when their real logic is disjoint."* That was a
real problem and the split solved it.

It also produced something we did not intend, and the modules say so themselves:

| Module | Its own docstring |
| --- | --- |
| `EditorHeader.tsx:47` | "…**purely to** shrink the parent's merge-clash surface — no behavior changed, so every prop here mirrors the exact value/handler `EditorView` used to close over directly" |
| `ProjectLoadStates.tsx:20` | "…**a pure move** of the first three `<Match>` branches" |
| `TrackEditor.tsx:49` | "every prop here mirrors the exact value/handler `EditorView` used to close over directly, so this is **a pure structural move**" |
| `useEditorShortcuts.ts:38` | "…as **a plain function of the same dependencies** `EditorView` already held" |

The lines moved. The state did not. `EditorView` kept its eight signals, the selection
reconciliation, the two lifted controller handles, and the analytics for sample
loading — so every extracted module had to grow an interface wide enough to receive
that state back:

- `EditorHeader` takes **23 props**. Eight of them are `ProjectAudioControls`
  disassembled into individual accessors and callbacks.
- `TrackEditor` takes **17 props** and passes 12 straight through untouched.
- `useEditorShortcuts` takes an **11-field options bag**, and its docstring
  pre-emptively defends that shape rather than reducing it.
- `editorViewModel.ts` exports **14 functions** — several of them a single property
  access (`editedInstrument = track?.instrument ?? null`) — to exactly **one** caller,
  each re-wrapped in a one-line `createMemo`.

Files got smaller; interfaces got wider. That is the definition of a shallow module,
and it costs in three ways we can now measure:

1. **Change amplification.** Adding one piano-roll keyboard operation edits five
   files, three of which only move a function pointer. Adding one transport control
   edits four.
2. **Testability.** Because no module beneath the view owns any editor state, the only
   interface that reaches editor behaviour is a rendered DOM. `EditorView.test.tsx` is
   924 lines with ~165 lines of setup, four dynamic imports, a real `AudioRuntime`, a
   real repository, and four near-duplicate `renderSlice()` helpers. Asserting that
   `O` toggles the metronome boots the repository, the audio runtime, the library
   client, the arrangement and the mixer.
3. **Duplication under pressure.** Three separate test files independently reimplement
   the gesture-to-reactive bridge that `EditorView`/`useEditorSession` owns, because
   there is no smaller module to borrow it from — one of them,
   `transformPanelHarness.tsx`, is test-only code shipped in `src/`.

The codebase already contains the shape that avoids this, twice:
`EditorSession` (framework-free, behind the thin `useEditorSession` adapter) and
`libraryClient`/`audition` (one injected function-shaped seam each). Neither is hard
to test and neither leaks its internals to callers.

## Decision

**A module extracted from a composition root takes state with it, or it is not
extracted.**

A split that leaves the state behind is not a smaller step toward the same goal — it
moves in the opposite direction, because it converts implicit closure access into an
explicit wide interface that every future change must thread through. If the state
cannot move yet, leave the code inline and say why.

Three rules follow.

### 1. Interface width is the acceptance measure, not file length

A refactor of a hot module states the before/after interface width of every module it
touches — props, exported functions, or returned members — and the total must go
**down**. A PR that halves a file while doubling its props has not deepened anything
and should say so plainly rather than claim the win.

Rough guidance, not a gate: a surface above ~10 props is usually receiving state that
should have moved with it. `EditorHeader` at 23 and `TrackEditor` at 17 are the
worked examples of what to avoid.

### 2. Pass modules, not their fields

Where a coherent module already exists, cross the seam with it whole.
`ProjectAudioControls` is a good interface; taking it apart into eight props to reach
`EditorHeader`, then reassembling the pieces, is what makes a new transport control a
four-file change.

### 3. Do not extract a pure function whose caller holds the risk

`editorViewModel.ts` was extracted so its derivations could "be unit tested without
rendering the editor," and its test spends 309 lines — 1.75× the module — on
functions that are mostly property accesses. Meanwhile the failure modes its own
comments describe (which memo re-runs, whether `hasSelection()` can be memoized,
whether `playheadTicks` crosses as an accessor or a value) are all in the composition,
and none of them is covered.

Apply the deletion test before extracting: if deleting the module would concentrate
complexity, it earns its keep; if it would merely move it back, keep it inline and
put the state somewhere a test can reach instead.

## What this does not say

- **It is not a rule against small modules.** `stepStroke`, `pitchClass`,
  `placementGeometry` and `search.ts` are pure modules with real logic and narrow
  interfaces. The rule is about extractions *from a composition root* that leave the
  state behind.
- **It does not retroactively condemn `REFACTOR-001`.** That issue solved the problem
  it was scoped to, under a `blocked` label and real queue pressure. This ADR exists
  because the *next* split should not repeat the shape, not because the last one was
  wrong to happen.
- **It is not a licence to widen a PR.** The 400-line ceiling and one-purpose rule in
  `CLAUDE.md` still hold. Moving state is what makes a stack's slices independently
  green, not an excuse to skip slicing.

## Consequences

### What this buys

- Editor behaviour becomes testable through an interface instead of a mount, which is
  where the 924-line test and its four render helpers come from.
- Change amplification drops: the five-file and four-file chains above collapse to one
  module each.
- The `src/` tree stops accumulating test-only harnesses that exist because a real
  interface is not drivable.

### What this costs

- **It is slower than a mechanical split.** Moving state means designing an interface,
  which is real work; moving lines is nearly free. A team under queue pressure will
  feel this, and `REFACTOR-001` was exactly that situation.
- **It needs a framework-free module per surface**, which is one more module than the
  "just components" shape, and Solid's ergonomics do not push you toward it.
- **It concentrates risk.** A deep module is one place where a mistake reaches every
  caller — the flip side of locality. The mitigation is that it is also one place to
  test.
- **Interface width is a proxy, not a truth.** A 6-prop module can still be shallow.
  The measure is there to make the conversation concrete, not to be gamed.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Leave it — the split achieved its merge-clash goal | It did, but the cost is now the dominant friction in the hottest directory in the repo; each new editor feature pays it |
| Split further into more, smaller components | More extractions of the same shape widen more interfaces; the problem is where the state is, not how many files it is spread across |
| Move editor state into a Solid context provider | Solves the prop threading but not the testability — a context still needs a rendered tree, and the `EditorSession` precedent shows the framework-free module is reachable |
| Adopt a store library (Zustand-style) for editor state | A dependency for a problem the codebase already solves twice with plain modules; it would also sit awkwardly beside the command layer, which owns all domain mutation |
| Write the rule into `CLAUDE.md` instead of an ADR | `CLAUDE.md` says what to do; it does not carry the reasoning or the worked example, and this decision is one a future review would otherwise re-litigate from scratch |

## Revisit when

- `REFACTOR-003` lands and the workspace module's real interface width is known — if
  it does not come in well under what it replaces, the rule needs sharpening or the
  shape is wrong.
- A surface legitimately needs a wide interface (a settings panel over many unrelated
  parameters is the plausible case), which would make rule 1 a poor default rather
  than a good one.
- Solid's own patterns change enough that a framework-free module stops being the
  cheapest way to hold testable state.
