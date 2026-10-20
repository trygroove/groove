/**
 * Content fingerprints for change detection (PRD section 9.3: "The projection
 * exposes revision counters at song, track, clip, asset, and automation
 * granularity so unrelated edits do not invalidate all cached geometry").
 *
 * Schema-v1 (`src/domain`) has one project-wide revision counter
 * (`metadata.revision`) and stores no per-track/per-clip counters; adding
 * them would be a domain-schema change. Per-entity "did it change" comes from
 * two projection-side mechanisms instead: this module's deterministic content
 * fingerprint (two calls fingerprinting the same relevant fields always agree,
 * so a builder can compare against the previous build and reuse the previous
 * object when they match) and the identity counters in `revision.ts`.
 *
 * Which change detector to use (GRV-80; the same note heads `fingerprint.ts`
 * and `revision.ts`):
 *
 *  - `revision.ts`: an object-identity counter. A per-entity render-cache key
 *    within one process; free, but meaningless across reloads, tabs or builds.
 *    The arrangement projection labels entities with it.
 *  - `fingerprint.ts`: content equality (stable JSON + FNV-1a), valid across
 *    builds and processes. It has two reasons to exist: the audio
 *    `topologyFingerprint` (node-graph shape vs. a changed value, which an
 *    identity counter cannot express) and the assistant context fingerprint
 *    (did the song change, selected notes included).
 *
 * For a new projection: use the counter when the only consumer is a cache
 * inside this process; use a fingerprint when equality must survive a process
 * boundary or must separate kinds of change. Either way, every input the
 * output reads must be in the dependency list: `projectionFreshness.test.ts`
 * changes one field at a time to catch the ones that are not.
 */

/**
 * Stable JSON text for a plain value: object keys are written in sorted
 * order at every nesting depth regardless of insertion order, so two
 * structurally-equal values always produce byte-identical text. Arrays are
 * written in the given order — a caller with an order-insensitive collection
 * (e.g. a device chain that should be compared by an `order` field rather
 * than array position) must sort it before calling this.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortObjectKeys);
}

function sortObjectKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = (value as Record<string, unknown>)[key];
  }
  return sorted;
}

/** FNV-1a, 32-bit. Not cryptographic — only used to shorten a fingerprint key. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A short, deterministic fingerprint for `value`. Equal relevant fields
 * always produce an equal fingerprint; this is the "revision/change
 * information" every projection in this module exposes.
 */
export function fingerprintOf(value: unknown): string {
  return fnv1a(stableStringify(value)).toString(36);
}

/**
 * Object-identity fast path for incremental projection rebuilds.
 *
 * Domain state is edited immutably with structural sharing (see
 * `src/commands/projectEdits.ts`: "a note edit on a 50-track project leaves 49
 * track objects referentially identical"). So on a rebuild, most source
 * entities arrive as the *exact same object reference* they had last time, and
 * the only thing a projection builder needs to know is "did this entity's
 * source change at all?" — which reference equality answers in O(1), before
 * any stable-stringify or hash.
 *
 * `fingerprintOf` alone cannot skip that work: it must serialize and hash the
 * entity to compute the digest it then compares. This helper lets a builder
 * short-circuit the common no-change case entirely. It records, per previously
 * built projection entry, the source inputs (`deps`) it was derived from, and
 * `reuseIfUnchanged` returns the previous entry — skipping the fingerprint —
 * when every dependency is `Object.is`-identical to last time.
 *
 * `deps` is usually just the one source entity object, but a builder whose
 * output also depends on values computed from *other* entities (e.g. a track
 * row's pixel offset, which moves when an earlier track's height changes)
 * lists those scalars too, so the fast path never reuses a stale derived
 * value. When any dependency differs, the builder falls through to its normal
 * fingerprint path, so correctness never rests on this cache — only speed.
 *
 * Backed by a `WeakMap` keyed on the projection entry, so it adds no field to
 * the projection's published shape (invisible to `Object.keys`, JSON,
 * structural typing, and deep-equality assertions) and needs no manual
 * eviction: an entry no longer referenced by the current projection is
 * collected with its dependency record.
 */
type Deps = readonly unknown[];

const sourceDeps = new WeakMap<object, Deps>();

function depsEqual(a: Deps, b: Deps): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

/**
 * Records the source inputs `entry` was built from, and returns `entry`, so a
 * builder can write `return rememberSource(built, [source]);` in one line.
 */
export function rememberSource<T extends object>(entry: T, deps: Deps): T {
  sourceDeps.set(entry, deps);
  return entry;
}

/**
 * Returns `previous` when it was built from source inputs identical (by
 * `Object.is`) to `deps`, letting the caller skip fingerprinting entirely;
 * otherwise `undefined`, so the caller computes the entry normally. A
 * `previous` that predates this cache (no recorded deps) never matches, so an
 * older projection object degrades to the fingerprint path rather than
 * misfiring.
 */
export function reuseIfUnchanged<T extends object>(
  previous: T | undefined,
  deps: Deps,
): T | undefined {
  if (!previous) return undefined;
  const recorded = sourceDeps.get(previous);
  if (recorded && depsEqual(recorded, deps)) {
    return previous;
  }
  return undefined;
}
