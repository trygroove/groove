import type { JSX } from "@solidjs/web";
import type {
  Gesture,
  GestureOptions,
  RawCommandInput,
  TransactionResult,
} from "../../commands";
import { deviceTypeDefinition } from "../../domain/devices";
import type { Device } from "../../domain/entities";
import { MASTER_VOLUME } from "../../domain/parameters";
import { ariaBool } from "../../shared/aria";
import type { TrackLevel } from "../tracks/trackLevels";
import LevelMeter from "./LevelMeter";
import { DbFader } from "./TrackFaders";

/** A chain's devices by name, in signal order, for a strip's footer (#447). */
export function chainSummary(devices: readonly Device[]): string {
  if (devices.length === 0) return "No devices";
  return devices
    .map((device) => deviceTypeDefinition(device.type)?.label ?? device.type)
    .join(" · ");
}

export interface MasterStripProps {
  /** The master's volume, in dB. */
  readonly volume: number;
  readonly devices: readonly Device[];
  /** Whether the chain below the desk is the master's, not a return's (#1106). */
  readonly selected: boolean;
  /**
   * The mix's level as it leaves for the speakers (GRV-44), reactively: its
   * meter goes red when the mix clips, as a track's does.
   */
  level(): TrackLevel | null;
  /** Takes the user to the master's effects, below the desk. */
  onSelect(): void;
  onFirstUse(): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/**
 * The master as the last strip on the desk, pinned to its right edge (#447):
 * its name — the way to its effects — its volume on the same fader law as a
 * track's, the mix's level meter beside it (GRV-44), and the chain it carries.
 * `master.volume` was in the song but had no control until now.
 */
export default function MasterStrip(props: MasterStripProps): JSX.Element {
  return (
    <div class="mixer-strip mixer-master-strip">
      <div class="mixer-strip-head">
        <button
          type="button"
          class="mixer-master-select"
          aria-pressed={ariaBool(props.selected)}
          onClick={() => props.onSelect()}
        >
          Master
        </button>
      </div>
      <div class="mixer-strip-controls">
        <DbFader
          definition={MASTER_VOLUME}
          target={{ scope: "master", parameterId: MASTER_VOLUME.id }}
          value={props.volume}
          inputId="mixer-volume-master"
          ariaLabel="Master volume"
          summary="Set master volume"
          onCommit={() => props.onFirstUse()}
          dispatch={props.dispatch}
          beginGesture={props.beginGesture}
        />
        <div class="mixer-meter-column">
          <span class="mixer-meter-label" aria-hidden="true">
            Lvl
          </span>
          <LevelMeter level={props.level} label="Master level" />
        </div>
      </div>
      <div class="mixer-strip-actions">
        <span class="mixer-strip-chain" title={chainSummary(props.devices)}>
          {chainSummary(props.devices)}
        </span>
      </div>
    </div>
  );
}
