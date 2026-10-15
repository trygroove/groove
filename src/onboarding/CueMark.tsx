import type { JSX } from "@solidjs/web";
import "./CueMark.css";

export interface CueMarkProps {
  /** Whether Cue is speaking: the squares pulse outwards and brighten. */
  readonly active?: boolean;
  /** The mark's size in pixels. */
  readonly size?: number;
}

/**
 * Cue's mark (GRV-25): concentric squares, square-cornered and monochrome
 * like everything else (docs/design.md). They breathe slowly at rest and
 * pulse while Cue speaks, the brightest thing on the welcome's black. It is
 * decoration: the name beside it is what a screen reader reads.
 */
export default function CueMark(props: CueMarkProps): JSX.Element {
  const size = () => props.size ?? 56;
  return (
    <svg
      class={["cue-mark", { "cue-mark-active": props.active ?? false }]}
      width={size()}
      height={size()}
      viewBox="0 0 56 56"
      aria-hidden="true"
    >
      <rect class="cue-mark-ring cue-mark-ring-3" x="2" y="2" width="52" height="52" />
      <rect class="cue-mark-ring cue-mark-ring-2" x="10" y="10" width="36" height="36" />
      <rect class="cue-mark-ring cue-mark-ring-1" x="18" y="18" width="20" height="20" />
      <rect class="cue-mark-core" x="25" y="25" width="6" height="6" />
    </svg>
  );
}
