import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sleeve from "./Sleeve";

/** The sleeve component: it animates, or under reduced motion lands at once. */

const strokeRect = vi.fn();
const fakeContext = {
  fillRect: vi.fn(),
  strokeRect,
  fillText: vi.fn(),
  measureText: (text: string) => ({ width: text.length * 7 }),
  setTransform: vi.fn(),
} as unknown as CanvasRenderingContext2D;

function stubMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: reduce && query.includes("reduce") }) as MediaQueryList,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    fakeContext as never,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 400,
    height: 300,
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderSleeve = () =>
  render(() => (
    <Sleeve
      stripes={[{ color: "#ff0000", lanes: [{ startBar: 0, lengthBars: 4 }] }]}
      bars={8}
      name="Night Drive"
      meta="120 BPM"
    />
  ));

describe("Sleeve", () => {
  it("describes the cover by how many track colours it is drawn from", () => {
    stubMotion(true);
    renderSleeve();
    expect(
      screen.getByRole("img", { name: "Cover drawn from 1 track colours" }),
    ).toBeVisible();
  });

  it("appears already landed, with no frame request, under reduced motion", () => {
    stubMotion(true);
    const request = vi.spyOn(window, "requestAnimationFrame");
    renderSleeve();
    expect(request).not.toHaveBeenCalled();
    expect(strokeRect).toHaveBeenCalledTimes(1);
  });

  it("animates frame by frame otherwise, and stops when the screen goes", () => {
    stubMotion(false);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const view = renderSleeve();
    expect(frames).toHaveLength(1);
    expect(strokeRect).not.toHaveBeenCalled();
    frames[0](performance.now() + 100);
    expect(frames).toHaveLength(2);
    view.unmount();
    expect(cancel).toHaveBeenCalledWith(2);
  });
});
