// Shared clock abstraction.
//
// Later domain code (command timestamps, revision authorship, autosave
// backoff, etc.) should depend on a `Clock` rather than calling `Date.now()`
// directly, so tests can inject a deterministic one instead of racing real
// time. This lives outside `src/testing` so that
// production code can use it as well as tests.

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

/** The real clock. Use this everywhere outside tests. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface ManualClock extends Clock {
  /** Jumps to an absolute time. */
  set(ms: number): void;
  /** Moves forward by a relative amount (negative values move it backward). */
  advance(ms: number): void;
}

/**
 * A deterministic, manually-driven clock for tests. Starting time defaults to
 * a fixed epoch (not `Date.now()`) so a test's expected output does not
 * depend on when the test happens to run.
 */
export function createManualClock(startMs = 0): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}
