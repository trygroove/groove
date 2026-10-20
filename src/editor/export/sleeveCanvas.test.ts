import { describe, expect, it } from "vitest";
import { COLOR_TOKENS } from "../../arrangement/canvasRenderer";
import {
  drawSleeve,
  fitLabel,
  pixelRuns,
  resolveSleevePalette,
  type SleeveFrame,
} from "./sleeveCanvas";

/** The sleeve's drawing, against a context that records what it is asked to paint. */

interface Painted {
  readonly op: "fillRect" | "strokeRect" | "fillText";
  readonly style: string;
  readonly alpha: number;
  readonly args: readonly unknown[];
}

function recordingContext() {
  const painted: Painted[] = [];
  const state = {
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 0,
    font: "",
  };
  const record = (op: Painted["op"], style: string, args: unknown[]) =>
    painted.push({ op, style, alpha: state.globalAlpha, args });
  const ctx = Object.assign(state, {
    fillRect: (...args: unknown[]) => record("fillRect", state.fillStyle, args),
    strokeRect: (...args: unknown[]) => record("strokeRect", state.strokeStyle, args),
    fillText: (...args: unknown[]) => record("fillText", state.fillStyle, args),
    // Seven units a character: enough to test where a label is cut.
    measureText: (text: string) => ({ width: text.length * 7 }),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, painted, state };
}

const RED = "#ff0000";
const BLUE = "#0000ff";
const frame: SleeveFrame = {
  width: 400,
  height: 300,
  bars: 8,
  name: "Night Drive",
  meta: "120 BPM · 2:30",
  stripes: [
    { color: RED, lanes: [{ startBar: 0, lengthBars: 4 }] },
    { color: BLUE, lanes: [{ startBar: 2, lengthBars: 6 }] },
  ],
  palette: resolveSleevePalette(),
};

describe("fitLabel", () => {
  const { ctx } = recordingContext();

  it("leaves a label that fits as it is", () => {
    expect(fitLabel(ctx, "NIGHT DRIVE", 77)).toBe("NIGHT DRIVE");
  });

  it("shortens a long label with an ellipsis, within the width (GRV-158)", () => {
    const name = "SUMMER_ANTHEM_FINAL_MIX_V12_WITH_NEW_VOCALS_AND_EXTRA_BASS_MASTER";
    const label = fitLabel(ctx, name, 200);
    expect(label.endsWith("…")).toBe(true);
    expect(name.startsWith(label.slice(0, -1))).toBe(true);
    expect(ctx.measureText(label).width).toBeLessThanOrEqual(200);
  });
});

describe("drawSleeve", () => {
  it("paints black ground, then only the tracks' own colours for the stripes", () => {
    const { ctx, painted } = recordingContext();
    drawSleeve(ctx, frame, 1);
    const fills = painted.filter((paint) => paint.op === "fillRect");
    expect(fills[0].style).toBe(COLOR_TOKENS.background[1]);
    expect(fills.slice(1).map((paint) => paint.style)).toEqual([RED, BLUE]);
  });

  it("starts each stripe on its arrangement row and lands it in the square", () => {
    const start = recordingContext();
    drawSleeve(start.ctx, frame, 0);
    const [from] = start.painted.filter((paint) => paint.style === BLUE);
    // Row 1 of 2 in a 300px-high arrangement, full width, faint.
    expect(from.args.slice(0, 2)).toEqual([(2 / 8) * 400, 150]);
    expect(from.alpha).toBeCloseTo(0.25);

    const end = recordingContext();
    drawSleeve(end.ctx, frame, 1);
    const [to] = end.painted.filter((paint) => paint.style === BLUE);
    const side = 300 * 0.72;
    const ox = (400 - side) / 2;
    const oy = (300 - side) / 2 - 12;
    // Clip edges land on whole pixels (#839).
    expect(to.args[0]).toBe(Math.round(ox + (2 / 8) * side));
    expect(to.args[1]).toBeCloseTo(oy + side / 2);
    expect(to.alpha).toBe(1);
  });

  it("keeps a long name's caption inside the sleeve's width (GRV-158)", () => {
    const { ctx, painted } = recordingContext();
    const name = "summer_anthem_final_mix_v12_with_new_vocals_and_extra_bass_MASTER";
    drawSleeve(ctx, { ...frame, name }, 1);
    const [caption] = painted.filter((paint) => paint.op === "fillText");
    const [text, x] = caption.args as [string, number];
    expect(text.endsWith("…")).toBe(true);
    expect(x + text.length * 7).toBeLessThanOrEqual(frame.width);
  });

  it("frames the sleeve in white and names it, in capitals, only once landed", () => {
    const mid = recordingContext();
    drawSleeve(mid.ctx, frame, 0.5);
    expect(mid.painted.some((paint) => paint.op !== "fillRect")).toBe(false);

    const { ctx, painted, state } = recordingContext();
    drawSleeve(ctx, frame, 1);
    const [border] = painted.filter((paint) => paint.op === "strokeRect");
    expect(border.style).toBe(COLOR_TOKENS.playhead[1]);
    expect(state.lineWidth).toBe(1);
    const text = painted.filter((paint) => paint.op === "fillText");
    expect(text.map((paint) => paint.args[0])).toEqual(["NIGHT DRIVE", "120 BPM · 2:30"]);
    expect(text.map((paint) => paint.style)).toEqual([
      COLOR_TOKENS.playhead[1],
      COLOR_TOKENS.textMuted[1],
    ]);
  });

  it("paints clips that touch or overlap as one span, so their joins leave no seam (#839)", () => {
    const { ctx, painted } = recordingContext();
    drawSleeve(
      ctx,
      {
        ...frame,
        bars: 4,
        stripes: [
          {
            color: RED,
            lanes: [
              { startBar: 0, lengthBars: 1 },
              { startBar: 1, lengthBars: 2 },
              { startBar: 2, lengthBars: 1 },
              { startBar: 3, lengthBars: 1 },
            ],
          },
          {
            color: BLUE,
            lanes: [
              { startBar: 0, lengthBars: 1 },
              { startBar: 2, lengthBars: 2 },
            ],
          },
        ],
      },
      1,
    );
    const side = 300 * 0.72;
    const ox = (400 - side) / 2;
    const spans = (colour: string) =>
      painted
        .filter((paint) => paint.style === colour)
        .map(({ args: [x, , w] }) => [x as number, (x as number) + (w as number)]);
    const [red] = spans(RED);
    expect(spans(RED)).toHaveLength(1);
    expect(red[0]).toBe(Math.round(ox));
    expect(red[1]).toBe(Math.round(ox + side));
    // A real gap between clips stays a gap.
    expect(spans(BLUE)).toHaveLength(2);
  });

  it("draws no stripe in a colour that is not a track's, whatever the progress", () => {
    for (const progress of [0, 0.3, 1]) {
      const { ctx, painted } = recordingContext();
      drawSleeve(ctx, frame, progress);
      const colours = new Set(painted.map((paint) => paint.style));
      for (const colour of colours) {
        expect([
          RED,
          BLUE,
          COLOR_TOKENS.background[1],
          COLOR_TOKENS.playhead[1],
          COLOR_TOKENS.textMuted[1],
        ]).toContain(colour);
      }
    }
  });
});

describe("pixelRuns", () => {
  const lanes = (...spans: [number, number][]) =>
    spans.map(([startBar, lengthBars]) => ({ startBar, lengthBars }));

  it("puts every edge on a whole device pixel", () => {
    for (const scale of [1, 2, 3]) {
      for (const [left, right] of pixelRuns(
        lanes([0.3, 1.1], [2, 0.7]),
        72.8,
        93.6,
        scale,
      )) {
        expect(Number.isInteger(left * scale)).toBe(true);
        expect(Number.isInteger(right * scale)).toBe(true);
      }
    }
  });

  it("joins clips a sub-pixel gap apart, so no seam shows between them (#839)", () => {
    // Four 1-bar clips each a tick short (767 of 768): 0.12px gaps at 1x,
    // which rounding would otherwise turn into a whole black pixel.
    const short = 767 / 768;
    const runs = lanes([0, short], [1, short], [2, short], [3, short]);
    for (const scale of [1, 2]) {
      expect(pixelRuns(runs, 72.8, 93.6, scale)).toHaveLength(1);
    }
  });

  it("keeps a gap of a pixel or more", () => {
    // A quarter-bar gap at 93.6px a bar is about 23px.
    expect(pixelRuns(lanes([0, 1], [1.25, 1]), 0, 93.6, 1)).toHaveLength(2);
  });

  it("gives a clip too short to see one device pixel", () => {
    const [[left, right]] = pixelRuns(lanes([0, 0.001]), 10, 93.6, 2);
    expect(right - left).toBe(0.5);
  });
});
