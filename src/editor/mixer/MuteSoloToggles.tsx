import type { JSX } from "@solidjs/web";
import { ariaBool } from "../../shared/aria";
import "./MuteSoloToggles.css";

export interface MuteSoloTogglesProps {
  /** What is muted or soloed: a track's name or a pad's, for the labels. */
  readonly name: string;
  readonly muted: boolean;
  readonly soloed: boolean;
  onToggle(flag: "muted" | "soloed"): void;
}

/**
 * The M and S pair (#447): one component and one look wherever a track or a
 * pad can be muted or soloed, the mixer strip, the track header and the pad
 * table alike. Engaged is the brightest thing in its row; the surface around
 * it sizes the pair.
 */
export default function MuteSoloToggles(props: MuteSoloTogglesProps): JSX.Element {
  return (
    <div class="mute-solo">
      <button
        type="button"
        class="mute-solo-toggle"
        aria-pressed={ariaBool(props.muted)}
        aria-label={`Mute ${props.name}`}
        title="Mute"
        onClick={() => props.onToggle("muted")}
      >
        M
      </button>
      <button
        type="button"
        class="mute-solo-toggle"
        aria-pressed={ariaBool(props.soloed)}
        aria-label={`Solo ${props.name}`}
        title="Solo"
        onClick={() => props.onToggle("soloed")}
      >
        S
      </button>
    </div>
  );
}
