# HARD-006 - Detailed performance audit and fixes

| Field | Value |
| --- | --- |
| Status | Implemented (`HARD-006`, issue [#127](https://github.com/trygroove/groove/issues/127)) |
| Scope | Audit of the per-edit and per-frame hot paths against the PRD section 10 performance budgets and section 9.3 arrangement acceptance, plus the fixes the audit surfaced |
| Gates | Blocks `REL-003` (the private-alpha release gate, issue #80) |

Related documents: [PRD section 10 Performance budgets](../prd.md#performance-budgets), [arrangement renderer spike & bench harness (retired)](../arrangement-renderer-spike.md), [testing](../testing.md). The arrangement acceptance budgets came from PRD section 9.3, since removed; the numbers themselves are restated here and in the spike record.

The issue body for #127 is empty; this document, together with the budgets it
restates, is the specification the task was implemented against. What lands here is
a *code* audit — the reproducible, machine-independent half of the milestone.
The half that needs the physical baseline device and a deployed build (measuring
the section 9.3 frame budgets on the 2019-MacBook-class machine in the gating
browsers, and observing the numbers from a hosted build) belongs to
`ARR-005`/`HARD-001` on the baseline device and to `OPS-001`'s hosted pass, and
is deliberately out of scope here — this task does not gate on a hosted
environment that is not provisioned.

## Method

The budgets that can regress silently on a developer laptop and only bite on the
baseline device are the ones driven by *work per edit* and *work per frame*, so
the audit walked the two paths that run on every project change:

1. **The audio projection** (`src/projection/audioProjection.ts`), rebuilt by
   `useProjectAudio`'s effect (`src/editor/composition/useProjectAudio.ts:242`) on every
   change to the open project. This is on the section 10 "pointer-driven note
   and parameter edits target a visual response within 50 ms" path: an edit
   commits a revision, the effect re-runs, and the projection is rebuilt before
   the graph reconciles.
2. **The arrangement projection** (`src/projection/arrangementProjection.ts`),
   rebuilt whenever the project revision the renderer reads moves. This feeds the
   section 9.3 acceptance that "frame cost is proportional primarily to visible
   objects, not total project duration or total offscreen clips," and the
   500 ms "opening the already-loaded reference project paints useful content"
   target.

Both were read against the reference project the budgets are stated for
(`createReferenceProject()`: 50 tracks, ten minutes, 2,500 placements, 100
automation lanes).

## Finding: projections re-fingerprinted every entity on every rebuild

Both projection builders are designed to be *incremental*: pass the previous
build back in and unchanged entities come back as the identical object, so a
consumer keyed on object identity does no work for what did not change. The
domain layer is built to make that cheap — `src/commands/projectEdits.ts`
guarantees structural sharing ("a note edit on a 50-track project leaves 49
track objects referentially identical"), so on a rebuild the *vast majority* of
source entities arrive as the exact same object reference they had last time.

The builders did not exploit that. Each per-entity builder computed a content
fingerprint (`fingerprintOf` → `stableStringify` → a full recursive
`JSON.stringify` with a key-sorting replacer that allocates a fresh sorted
object at every node — then an FNV-1a hash of the result) **unconditionally**,
then compared the digest to decide whether to reuse. The reuse was correct, but
paid for by serializing and hashing every entity on every rebuild:

- **Audio projection**, one-note edit on the reference project: 50 tracks × 2
  fingerprints (full + topology) + 2,500 placements + clips + 100 automation
  lanes + returns + assets — thousands of stable-stringify+hash passes, of which
  all but the edited entity's were pure waste.
- **Arrangement projection**, same edit: every one of the 2,500 placements plus
  every clip, section, row, and automation lane re-serialized and re-hashed,
  when ≥2,499 placements kept their source object reference.

This is exactly the shape section 9.3 forbids — cost proportional to *total*
project size, not to what changed — and it lands squarely on the 50 ms
pointer-edit budget, because it runs synchronously inside the edit's effect.

## Fix: an object-identity fast path, ahead of the fingerprint

`src/projection/fingerprint.ts` gains two helpers, `rememberSource` and
`reuseIfUnchanged`, backed by a `WeakMap` keyed on the previously built
projection entry. Each builder now, as its first step, asks whether the source
inputs it is about to build from are `Object.is`-identical to the ones the
previous entry was built from; if so it returns the previous entry immediately,
**skipping the stable-stringify and hash entirely**. Only when a dependency
actually differs does it fall through to the existing fingerprint path — so
correctness never rests on the fast path, only speed. The dependency list is
normally just the one source entity; a track *row*, whose fingerprint also
depends on its computed layout position, lists those scalars too so the fast
path can never reuse a stale derived value.

The `WeakMap` was chosen deliberately over adding a field to the projection
objects: it is invisible to `Object.keys`, JSON, structural typing, and the
deep-equality assertions the projection contract tests use, so **the published
`AudioSongProjection` / `ArrangementProjection` shapes are unchanged** — this is
not a contract change, only an internal speed-up. It also needs no manual
eviction: an entry no longer referenced by the live projection is collected with
its dependency record.

After the fix, a one-entity edit re-fingerprints exactly that entity (its
one-or-two shapes) and nothing else; an idempotent rebuild (same project object)
re-fingerprints nothing at all.

### Guard

`src/projection/incrementalReuse.test.ts` counts `fingerprintOf` invocations
across an incremental rebuild of the reference project and asserts the count
scales with *changed* entities, not project size: zero for an unchanged rebuild,
two for a one-track mixer edit (full + topology), one for a one-placement move.
The guard was confirmed to fail on the pre-fix behaviour (disabling the fast
path drives the counts back into the thousands) and pass after. The identity of
reused entries and the correctness of a genuinely changed entry are covered by
the existing `audioProjection.test.ts` / `arrangementProjection.test.ts` reuse
suites, which continue to pass unchanged. `fingerprint.test.ts` covers the
helper directly, including that it keys on identity rather than deep equality and
that an entry predating the cache degrades to the fingerprint path rather than
misfiring.

## Budgets confirmed already within spec (no change needed)

The audit did not manufacture changes where the code was already correct. These
were examined and left alone:

- **Arrangement range/row queries** (`queryPlacementsInRange`, `findRowAtOffset`)
  already use the binary searches over per-track sorted arrays and row prefix
  sums that section 9.3 requires, so a viewport change is already
  `O(visible)`, not `O(project)`.
- **The audio graph reconciler** already reconciles by ID and only touches the
  subgraph of an entity whose projection entry changed (`ProjectAudioGraph`,
  PRD AUD-08); the fast path above makes "did this entry change?" cheaper to
  answer but does not alter that behaviour.
- **The waveform cache** already has the section 9.3 128 MiB LRU budget and
  generation-tracked cancellation.
- **The monitoring SDK** is already off the interactive path (dynamic import
  after first paint), enforced by `scripts/verify-bundle-budget.mjs`.

## Analytics

This task adds no new user-facing action, so it introduces no new OPS-02 event —
a performance fix to an internal projection is invisible to the user and to the
event catalog. The reliability event that covers the audio hot path this touches,
`audio_underrun` (sampled late-dispatch reporting), already exists and is
unchanged. There is no unmeasured user action introduced here to extend the
catalog for.

## What this task does *not* claim

- It does **not** claim the section 9.3 frame budgets are met on the physical
  baseline device. That measurement binds at `ARR-005`/`HARD-001` on that
  device in the gating browsers. The `FND-008` bench harness that would have
  been the tool for it was retired with the renderer spike it drove (see
  [the retirement record](../arrangement-renderer-spike.md)), so a harness must
  be stood back up against the production renderer first. This fix reduces the
  per-rebuild work such a measurement would see, but the measurement itself is
  not part of this task.
- It does **not** deploy, smoke-test, or observe any event from a hosted build.
  There is no hosted environment; that is `OPS-001`.
