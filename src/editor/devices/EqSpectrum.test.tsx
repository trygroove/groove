import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpectrumReading } from "../../audio/DeviceChain";
import type { DeviceId } from "../../domain/ids";
import type { DeviceSpectrumSource } from "./deviceSpectrum";
import EqSpectrum, { type FrameScheduler } from "./EqSpectrum";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** An `IntersectionObserver` the test moves on and off screen by hand. */
function stubIntersectionObserver() {
  const observed: Element[] = [];
  let report: IntersectionObserverCallback = () => {};
  class StubObserver {
    constructor(callback: IntersectionObserverCallback) {
      report = callback;
    }
    observe(target: Element) {
      observed.push(target);
    }
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", StubObserver);
  const setVisible = (isIntersecting: boolean) => {
    report(
      observed.map((target) => ({
        target,
        isIntersecting,
      })) as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
    flush();
  };
  return { observed, setVisible };
}

/** Frames run only when the test says so. */
function manualFrames() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const frames: FrameScheduler = {
    request(callback) {
      pending.set(next, callback);
      return next++;
    },
    cancel(handle) {
      pending.delete(handle);
    },
  };
  const tick = () => {
    const due = [...pending.values()];
    pending.clear();
    for (const callback of due) callback();
    flush();
  };
  return { frames, tick, pending };
}

function renderSpectrum() {
  const [playing, setPlaying] = createSignal(false);
  const reads: DeviceId[] = [];
  const db = new Float32Array(1024).fill(-40);
  const source: DeviceSpectrumSource = {
    isPlaying: playing,
    read(deviceId): SpectrumReading {
      reads.push(deviceId);
      return { db, binHz: 23.4375 };
    },
  };
  const { frames, tick, pending } = manualFrames();
  const { container } = render(() => (
    <svg aria-hidden="true" class="well-drawing">
      <EqSpectrum
        deviceId={"dev_eq" as DeviceId}
        source={source}
        width={300}
        height={100}
        frames={frames}
      />
    </svg>
  ));
  const path = () => container.querySelector(".eq-spectrum")?.getAttribute("d") ?? "";
  return { setPlaying, reads, tick, pending, path, container };
}

describe("EqSpectrum (LOOP-022)", () => {
  it("draws nothing and reads nothing while the transport is stopped", () => {
    const { reads, tick, pending, path } = renderSpectrum();
    tick();
    expect(pending.size).toBe(0);
    expect(reads).toEqual([]);
    expect(path()).toBe("");
  });

  it("redraws each frame while it plays, and stops drawing when it stops", () => {
    const { setPlaying, reads, tick, pending, path } = renderSpectrum();
    setPlaying(true);
    flush();
    tick();
    expect(reads).toEqual(["dev_eq"]);
    expect(path()).toMatch(/^M0,100 L/);
    tick();
    expect(reads).toHaveLength(2);

    setPlaying(false);
    flush();
    expect(pending.size).toBe(0);
    expect(path()).toBe("");
    tick();
    expect(reads).toHaveLength(2);
  });

  it("stops drawing off screen, and starts again when it comes back", () => {
    const { observed, setVisible } = stubIntersectionObserver();
    const { setPlaying, reads, tick, pending, path, container } = renderSpectrum();
    // It watches the drawing, whose box stays put while the path is empty.
    expect(observed).toEqual([container.querySelector("svg.well-drawing")]);
    setPlaying(true);
    flush();
    tick();
    expect(reads).toHaveLength(1);

    setVisible(false);
    expect(pending.size).toBe(0);
    expect(path()).toBe("");
    tick();
    expect(reads).toHaveLength(1);

    setVisible(true);
    expect(pending.size).toBe(1);
    tick();
    expect(reads).toHaveLength(2);
    expect(path()).toMatch(/^M0,100 L/);
  });
});
