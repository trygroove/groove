import type { JSX } from "@solidjs/web";

/**
 * The library window's line icons, drawn as the reference draws them
 * (`docs/library-browser.html`): 16-unit boxes stroked in `currentColor`, so
 * each takes its control's colour and state.
 */
function Icon(props: { children: JSX.Element }): JSX.Element {
  return (
    <svg
      class="library-modal-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export function SearchIcon(): JSX.Element {
  return (
    <Icon>
      <circle cx="7" cy="7" r="5" />
      <path d="M11 11l3.5 3.5" />
    </Icon>
  );
}

export function GridIcon(): JSX.Element {
  return (
    <Icon>
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" />
    </Icon>
  );
}

/** A die, for Shuffle. */
export function DiceIcon(): JSX.Element {
  return (
    <Icon>
      <rect x="2" y="2" width="12" height="12" stroke-width="1.4" />
      <circle cx="5.5" cy="5.5" r="0.9" fill="currentColor" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
      <circle cx="10.5" cy="10.5" r="0.9" fill="currentColor" />
    </Icon>
  );
}

export function ClearIcon(): JSX.Element {
  return (
    <Icon>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}
