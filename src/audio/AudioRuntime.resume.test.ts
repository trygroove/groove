import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resume()`'s own logic — call `Tone.start()` only when needed, wait out an
 * in-flight `close()`, and mark the runtime running — is independent of
 * whether a live `AudioContext` actually completes its browser resume
 * handshake. Tested here against a fake Tone module instead of the real one:
 * `AudioRuntime.test.ts` already covers `ensureContext()`/`close()` against a
 * genuine Tone context (reliable in this environment), but a live
 * `AudioContext.resume()` depends on an audio callback this sandbox has no
 * device to fire — see the comment at the top of that file.
 */
vi.mock("tone", () => {
  // biome-ignore lint/suspicious/noExplicitAny: minimal fake, not the real Tone.Context shape
  let current: any = null;

  class Context {
    state: "suspended" | "running" | "closed" = "suspended";
    rawContext = { suspend: vi.fn(async () => {}) };
    constructor() {
      current = this;
    }
    async close() {
      this.state = "closed";
    }
  }

  const start = vi.fn(async () => {
    if (current) current.state = "running";
  });

  return {
    Context,
    setContext: vi.fn((ctx: unknown) => {
      current = ctx;
    }),
    // `null` here (nothing installed yet) is intentionally not an
    // `instanceof Context` — it plays the same role as Tone's real
    // `DummyContext`: nothing adoptable, so `ensureContext()` falls
    // through to constructing a fresh one, matching this suite's
    // `contextsCreated` expectations.
    getContext: vi.fn(() => current),
    getDestination: vi.fn(() => ({})),
    start,
    // Test-only: this fake module is one singleton shared by every test in
    // this file (`vi.mock` factories run once), so without an explicit
    // reset a context a later test's runtime could wrongly "adopt" — from
    // an earlier test — the same way a stale global would. Production
    // code has no equivalent reset because `Tone`'s real global context
    // is meant to persist; only the test double needs unwinding.
    __resetForTest: () => {
      current = null;
    },
  };
});

import * as Tone from "tone";
import { AudioRuntime } from "./AudioRuntime";

beforeEach(() => {
  (Tone as unknown as { __resetForTest: () => void }).__resetForTest();
  vi.mocked(Tone.start).mockClear();
  vi.mocked(Tone.setContext).mockClear();
});

describe("AudioRuntime.resume", () => {
  it("creates the context if needed, calls Tone.start(), and marks the runtime running", async () => {
    const runtime = new AudioRuntime();
    expect(runtime.getState()).toBe("uninitialized");

    await runtime.resume();

    expect(Tone.start).toHaveBeenCalledTimes(1);
    expect(runtime.getState()).toBe("running");
    expect(runtime.diagnostics().contextsCreated).toBe(1);
  });

  it("does not call Tone.start() again once the context is already running", async () => {
    const runtime = new AudioRuntime();
    await runtime.resume();
    vi.mocked(Tone.start).mockClear();

    await runtime.resume();

    expect(Tone.start).not.toHaveBeenCalled();
    expect(runtime.getState()).toBe("running");
  });

  it("waits for an in-flight close() to settle before resuming a fresh context", async () => {
    const runtime = new AudioRuntime();
    await runtime.resume();

    const closePromise = runtime.close();
    const resumePromise = runtime.resume();

    await closePromise;
    await resumePromise;

    expect(runtime.getState()).toBe("running");
    // The close finished before the second resume created its context.
    expect(runtime.diagnostics().contextsCreated).toBe(2);
    expect(runtime.diagnostics().contextsClosed).toBe(1);
  });

  it("starts a new context when the browser closed the running one (GRV-55)", async () => {
    const runtime = new AudioRuntime();
    await runtime.resume();
    const closed = runtime.ensureContext() as unknown as { state: string };
    const generation = runtime.contextGeneration();
    // Closed by the browser, not by the runtime: its own state still says running.
    closed.state = "closed";
    expect(runtime.getState()).toBe("running");
    vi.mocked(Tone.start).mockClear();

    await runtime.resume();

    expect(Tone.start).toHaveBeenCalledTimes(1);
    const live = runtime.ensureContext() as unknown as { state: string };
    expect(live).not.toBe(closed);
    expect(live.state).toBe("running");
    expect(runtime.contextGeneration()).toBe(generation + 1);
    expect(runtime.diagnostics().contextsCreated).toBe(2);
    expect(runtime.contextState()).toBe("running");
    // The runtime tracks one context, not the dead one beside it.
    expect(runtime.registry.counts().byType.context).toBe(1);
  });
});
