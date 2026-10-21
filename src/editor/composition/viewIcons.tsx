import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
/**
 * The five views' icons (`UI-002`): abstract and monochrome, drawn on a
 * 24-unit grid with square corners like the transport's (`components/icons`).
 * The dock draws them on its tiles and the empty screen draws its own struck
 * through, so a view looks the same wherever it is named.
 */
export type ViewIconName =
  | "arrangement"
  | "sequence"
  | "instrument"
  | "library"
  | "mixer";

const DRAWINGS: Record<ViewIconName, () => JSX.Element> = {
  // 1: staggered clip bars, the song.
  arrangement: () => (
    <>
      <rect x="2" y="4" width="9" height="4" />
      <rect x="9" y="10" width="11" height="4" />
      <rect x="5" y="16" width="8" height="4" />
    </>
  ),
  // 2: a step grid, the clip.
  sequence: () => (
    <>
      <rect x="3" y="3" width="5" height="5" />
      <rect x="10" y="3" width="5" height="5" opacity="0.4" />
      <rect x="17" y="3" width="4" height="5" />
      <rect x="3" y="10" width="5" height="5" opacity="0.4" />
      <rect x="10" y="10" width="5" height="5" />
      <rect x="17" y="10" width="4" height="5" opacity="0.4" />
      <rect x="3" y="17" width="5" height="4" />
      <rect x="10" y="17" width="5" height="4" opacity="0.4" />
      <rect x="17" y="17" width="4" height="4" />
    </>
  ),
  // 3: a single waveform, the sound.
  instrument: () => (
    <polyline
      points="2,12 5,12 7,5 10,19 13,7 16,16 18,12 22,12"
      fill="none"
      stroke-width="2"
    />
  ),
  // 4: a shelf of sounds, the sounds you could swap in.
  library: () => (
    <>
      <rect x="3" y="4" width="3" height="14" />
      <rect x="8" y="7" width="3" height="11" />
      <rect x="13" y="5" width="3" height="13" />
      <rect x="17" y="9" width="3" height="9" transform="rotate(-12 18.5 13.5)" />
      <rect x="2" y="19" width="20" height="2" />
    </>
  ),
  // 5: three faders, the mix.
  mixer: () => (
    <>
      <rect x="5" y="3" width="2" height="18" />
      <rect x="11" y="3" width="2" height="18" />
      <rect x="17" y="3" width="2" height="18" />
      <rect x="3" y="13" width="6" height="3" />
      <rect x="9" y="6" width="6" height="3" />
      <rect x="15" y="15" width="6" height="3" />
    </>
  ),
};

export interface ViewIconProps {
  readonly view: ViewIconName;
  readonly size?: number;
  /** Struck through: the view has nothing to show (the empty screen). */
  readonly struck?: boolean;
}

export function ViewIcon(props: ViewIconProps): JSX.Element {
  return (
    <svg
      class="view-icon"
      width={props.size ?? 24}
      height={props.size ?? 24}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      stroke-width="0"
      stroke-linejoin="miter"
      stroke-linecap="square"
      aria-hidden="true"
    >
      {DRAWINGS[props.view]()}
      <Show when={props.struck}>
        <line x1="2" y1="22" x2="22" y2="2" stroke-width="2" />
      </Show>
    </svg>
  );
}
