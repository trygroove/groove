import { COLOR_TOKENS } from "../../arrangement/canvasRenderer";
import type { LaneSpan } from "./trackLanes";

/**
 * The sleeve of the Export celebration (EXP-004, docs/export-dialog.html
 * `sleeve`): the exported tracks' lanes fly from their arrangement rows into a
 * square of stripes, one stripe per track, then the song's name, tempo and
 * length settle under it. Everything on it is the theme's black, white and
 * greys except the stripes, which are the tracks' own colours: track colour is
 * the one hue in the product. A canvas cannot read a custom property, so the
 * greys come off the document once, as `canvasRenderer.ts` resolves its own.
 */

/** How long the lanes take to land, in milliseconds. */
export const SLEEVE_MS = 1400;

/** One track's stripe: its colour, and where its clips sit in the song. */
export interface SleeveStripe {
  readonly color: string;
  readonly lanes: readonly LaneSpan[];
}

const TOKEN_NAMES = ["background", "playhead", "textMuted"] as const;
export interface SleevePalette
  extends Readonly<Record<(typeof TOKEN_NAMES)[number], string>> {
  readonly fontFamily: string;
}

export function resolveSleevePalette(): SleevePalette {
  const style =
    typeof window === "undefined"
      ? null
      : window.getComputedStyle(document.documentElement);
  const palette = {} as Record<(typeof TOKEN_NAMES)[number], string>;
  for (const name of TOKEN_NAMES) {
    const [token, fallback] = COLOR_TOKENS[name];
    palette[name] = style?.getPropertyValue(token).trim() || fallback;
  }
  return { ...palette, fontFamily: style?.fontFamily || "sans-serif" };
}

export interface SleeveFrame {
  readonly width: number;
  readonly height: number;
  readonly stripes: readonly SleeveStripe[];
  /** The song's length in bars, which a stripe's lanes span. */
  readonly bars: number;
  readonly name: string;
  /** `120 BPM · 2:30`. */
  readonly meta: string;
  readonly palette: SleevePalette;
}

/**
 * A stripe's clips as unbroken runs: clips that touch or overlap become one
 * span. Two rectangles meeting on a fractional pixel each antialias their
 * shared edge, which lets the ground show through as a faint seam (#839), and
 * overlapping ones would double up while the lanes are still translucent.
 */
function mergeLanes(lanes: readonly LaneSpan[]): LaneSpan[] {
  const runs: { startBar: number; endBar: number }[] = [];
  for (const { startBar, lengthBars } of [...lanes].sort(
    (a, b) => a.startBar - b.startBar,
  )) {
    const last = runs.at(-1);
    const endBar = startBar + lengthBars;
    if (last && startBar <= last.endBar) last.endBar = Math.max(last.endBar, endBar);
    else runs.push({ startBar, endBar });
  }
  return runs.map(({ startBar, endBar }) => ({
    startBar,
    lengthBars: endBar - startBar,
  }));
}

/**
 * Runs as `[left, right]` in canvas units, each edge on a whole device pixel,
 * at least one device pixel wide, and joined where the gap between two is
 * under a device pixel. An edge on a fractional pixel antialiases, and so does
 * a sub-pixel gap, so two clips that nearly touch (a tick apart) would still
 * leave a faint seam of the ground between them (#839).
 */
export function pixelRuns(
  runs: readonly LaneSpan[],
  x: number,
  barWidth: number,
  scale: number,
): [number, number][] {
  // Join on the true gap, in device pixels, then round: rounding first can
  // turn a gap of a tenth of a pixel into a whole one.
  const joined: [number, number][] = [];
  for (const { startBar, lengthBars } of runs) {
    const left = (x + startBar * barWidth) * scale;
    const right = (x + (startBar + lengthBars) * barWidth) * scale;
    const last = joined.at(-1);
    if (last && left - last[1] < 1) last[1] = Math.max(last[1], right);
    else joined.push([left, right]);
  }
  const out = joined.map(([left, right]): [number, number] => {
    const l = Math.round(left);
    return [l, Math.max(l + 1, Math.round(right))];
  });
  return out.map(([left, right]) => [left / scale, right / scale]);
}

/**
 * `text`, shortened with an ellipsis until it paints within `maxWidth` canvas
 * units. A canvas cannot wrap or clip to a box it was not given, so a long
 * project name would otherwise run past the sleeve (GRV-158).
 */
export function fitLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end--;
  return `${text.slice(0, end)}…`;
}

/** The sleeve at `progress`, 0 (lanes where the arrangement has them) to 1 (landed). */
export function drawSleeve(
  ctx: CanvasRenderingContext2D,
  frame: SleeveFrame,
  progress: number,
): void {
  const { width: W, height: H, stripes, bars, palette } = frame;
  const k = Math.min(1, Math.max(0, progress));
  const ease = 1 - (1 - k) ** 3;
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, W, H);
  const n = stripes.length || 1;
  const side = Math.min(W, H) * 0.72;
  const ox = (W - side) / 2;
  const oy = (H - side) / 2 - 12;
  const band = side / n;
  const scale = ctx.getTransform?.().a || 1;
  stripes.forEach((stripe, i) => {
    // Each lane flies from its arrangement row into its stripe of the sleeve.
    const fromY = (i / n) * H;
    const y = fromY + (oy + i * band - fromY) * ease;
    const x = ox * ease;
    const w = W + (side - W) * ease;
    ctx.fillStyle = stripe.color;
    ctx.globalAlpha = 0.25 + 0.75 * ease;
    for (const [left, right] of pixelRuns(mergeLanes(stripe.lanes), x, w / bars, scale)) {
      ctx.fillRect(left, y, right - left, Math.max(1, band - (n > 30 ? 0 : 1)));
    }
  });
  ctx.globalAlpha = 1;
  if (k < 1) return;
  ctx.strokeStyle = palette.playhead;
  ctx.lineWidth = 1;
  ctx.strokeRect(ox - 0.5, oy - 0.5, side + 1, side + 1);
  ctx.font = `600 12px ${palette.fontFamily}`;
  ctx.fillStyle = palette.playhead;
  ctx.fillText(fitLabel(ctx, frame.name.toUpperCase(), W - ox), ox, oy + side + 22);
  ctx.fillStyle = palette.textMuted;
  ctx.fillText(frame.meta, ox, oy + side + 40);
}
