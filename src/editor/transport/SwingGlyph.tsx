import type { JSX } from "@solidjs/web";

/**
 * The swing glyph: a long bar then a short one on a shared baseline, swung
 * eighths written as a dotted eighth plus a sixteenth. Square-cornered and
 * `currentColor`, drawn on the same 20-unit grid as the toolbar's Heroicons.
 */
export default function SwingGlyph(props: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      width={props.size ?? 18}
      height={props.size ?? 18}
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2" y="8" width="10" height="4" />
      <rect x="14" y="8" width="4" height="4" />
    </svg>
  );
}
