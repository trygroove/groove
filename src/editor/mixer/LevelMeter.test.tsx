import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { TrackLevel } from "../tracks/trackLevels";
import LevelMeter from "./LevelMeter";

afterEach(() => cleanup());

function renderMeter(
  orientation?: "vertical" | "horizontal",
  initial: TrackLevel | null = { db: -30, clipping: false },
) {
  const [level, setLevel] = createSignal(initial);
  render(() => <LevelMeter level={level} orientation={orientation} />);
  const meter = screen.getByRole("meter", { name: "Level" });
  return { meter, fill: meter.nextElementSibling as HTMLElement, setLevel };
}

describe("LevelMeter (#447)", () => {
  it("fills upward beside a mixer fader", () => {
    const { meter, fill } = renderMeter();
    expect(meter.parentElement?.className).toBe("mixer-meter");
    expect(fill.style.height).toBe("50%");
  });

  it("fills along the row in a track header", () => {
    const { meter, fill } = renderMeter("horizontal");
    expect(meter.parentElement?.className).toBe("level-meter-horizontal");
    expect(fill.style.width).toBe("50%");
    expect(fill.style.height).toBe("");
  });

  it("follows the level it is given, and rests at the floor without one", () => {
    const { meter, fill, setLevel } = renderMeter();
    setLevel({ db: -12, clipping: false });
    flush();
    expect(fill.style.height).toBe("80%");
    setLevel(null);
    flush();
    expect(fill.style.height).toBe("0%");
    expect(meter).toHaveAttribute("value", "-60");
  });

  it("shows a clip, in either orientation, when the level says so", () => {
    for (const orientation of ["vertical", "horizontal"] as const) {
      const quiet = renderMeter(orientation, { db: -1, clipping: false });
      expect(quiet.meter.parentElement).not.toHaveClass("clipping");
      quiet.setLevel({ db: -3, clipping: true });
      flush();
      // A clip is a peak, not the RMS the bar shows: the colour says it.
      expect(quiet.meter.parentElement).toHaveClass("clipping");
      cleanup();
    }
  });
});
