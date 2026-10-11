import type { JSX } from "@solidjs/web";

/**
 * The transport's own glyphs. Heroicons' solid set rounds every corner,
 * which fights the square-cornered design (docs/design.md), so these are
 * drawn on a 24-unit grid with mitred joins and square caps instead.
 */
type IconProps = { size?: number };

function Icon(props: IconProps & { children: JSX.Element }) {
  return (
    <svg
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
      {props.children}
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <polygon points="6,3.5 21,12 6,20.5" />
    </Icon>
  );
}

/** A sound from the library: a waveform's bars, for the sample slot (#447). */
export function SampleIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <rect x="2" y="9" width="3" height="6" />
      <rect x="7" y="4" width="3" height="16" />
      <rect x="12" y="7" width="3" height="10" />
      <rect x="17" y="10" width="3" height="4" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <rect x="5" y="5" width="14" height="14" />
    </Icon>
  );
}

export function LoopIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path d="M4 12V7h12M20 12v5H8" fill="none" stroke-width="2.5" />
      <polygon points="15,2.5 21,7 15,11.5" />
      <polygon points="9,12.5 3,17 9,21.5" />
    </Icon>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path d="M8 9h11v10h-8" fill="none" stroke-width="2.5" />
      <polygon points="9,3 3,9 9,15" />
    </Icon>
  );
}

export function RedoIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path d="M16 9H5v10h8" fill="none" stroke-width="2.5" />
      <polygon points="15,3 21,9 15,15" />
    </Icon>
  );
}

/**
 * A wind-up pyramid metronome: the tapered case on its plinth, and the
 * pendulum swung off-centre with its sliding weight.
 */
export function MetronomeIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <polygon points="8.5,2 15.5,2 20,19 4,19" fill="none" stroke-width="2" />
      <rect x="2.5" y="19" width="19" height="3" />
      <line x1="12" y1="17" x2="15.6" y2="5" stroke-width="2" />
      <rect
        x="-2.5"
        y="-1.4"
        width="5"
        height="2.8"
        transform="translate(13.6 11.6) rotate(16.7)"
      />
    </Icon>
  );
}

/** Help: a bold grotesk question mark, square-ended, without a circle. */
export function HelpIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path
        d="M8 9V8a4 4 0 0 1 8 0c0 2.2-4 2.8-4 5.5v1.5"
        fill="none"
        stroke-width="2.6"
        stroke-linecap="butt"
      />
      <rect x="10.7" y="18" width="2.6" height="2.6" />
    </Icon>
  );
}

/** The assistant's mark: a four-pointed spark (#849). */
export function SparkIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path d="M12 1.5l2.7 7.8L22.5 12l-7.8 2.7L12 22.5l-2.7-7.8L1.5 12l7.8-2.7z" />
    </Icon>
  );
}

/** A panel's settings: three faders at different levels (GRV-8). */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path d="M5 3v18M12 3v18M19 3v18" fill="none" stroke-width="2" />
      <rect x="2.5" y="13" width="5" height="3" />
      <rect x="9.5" y="6" width="5" height="3" />
      <rect x="16.5" y="15" width="5" height="3" />
    </Icon>
  );
}

/** Minimise a floating panel to a bar. */
export function MinimiseIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path d="M4.5 18.75h15" fill="none" stroke-width="2.4" />
    </Icon>
  );
}

/** Restore a minimised bar to a panel. */
export function RestoreIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path d="M5.25 15L12 8.25L18.75 15" fill="none" stroke-width="2.4" />
    </Icon>
  );
}

/** Dock a panel to the right edge: a frame with its right column filled. */
export function DockRightIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <rect x="2.25" y="3.75" width="19.5" height="16.5" fill="none" stroke-width="2" />
      <rect x="14.25" y="3.75" width="7.5" height="16.5" />
    </Icon>
  );
}

/** Float a docked panel: a frame with a small window in its corner. */
export function FloatIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <rect x="2.25" y="3.75" width="19.5" height="16.5" fill="none" stroke-width="2" />
      <rect x="12.75" y="12" width="7.5" height="6.75" />
    </Icon>
  );
}

/** Close a panel. */
export function CloseIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path
        d="M5.25 5.25l13.5 13.5M18.75 5.25l-13.5 13.5"
        fill="none"
        stroke-width="2.4"
      />
    </Icon>
  );
}

/** Send a message: an arrow pointing up and out of the composer (GRV-26). */
export function SendIcon(props: IconProps) {
  return (
    <Icon size={props.size}>
      <path d="M12 20V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke-width="2.6" />
    </Icon>
  );
}
