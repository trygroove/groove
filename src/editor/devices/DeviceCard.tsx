import { type JSX, Show } from "@solidjs/web";
import {
  HiSolidArrowPath,
  HiSolidDocumentDuplicate,
  HiSolidPower,
  HiSolidTrash,
} from "solid-icons/hi";
import {
  type DeviceChainTarget,
  duplicateDevice,
  type Gesture,
  type GestureOptions,
  type RawCommandInput,
  removeDevice,
  resetDevice,
  setDeviceBypass,
  type TransactionResult,
} from "../../commands";
import { CONTROL_PARTS, controlAddress } from "../../commands/controlAddress";
import { control } from "../../controls/control";
import { deviceTypeDefinition } from "../../domain/devices";
import type { Device } from "../../domain/entities";
import type { DeviceId } from "../../domain/ids";
import { ariaBool } from "../../shared/aria";
import DeviceControls from "./DeviceControls";
import DeviceWell, { hasDeviceWell } from "./DeviceWell";
import EqFaceplate from "./EqFaceplate";
import "./DeviceCard.css";

export interface DeviceCardProps {
  /** The chain the device is in: a track's inserts or the master's. */
  readonly chain: DeviceChainTarget;
  readonly device: Device;
  /** False once the chain is at its insert limit, so a copy has nowhere to go. */
  readonly canDuplicate: boolean;
  /** A fresh id for a duplicate; the command carries it, so redo reproduces it. */
  newDeviceId(): DeviceId;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** The song's tempo, so a synced delay's well draws its real echo times. */
  readonly tempo?: number;
}

/**
 * One device in a chain — a track's inserts (#241) or the master's (#283), PRD FX-01 —: its name, what can
 * be done to it, and its own controls.
 *
 * Every action is one existing `device.*` command, so each is one validated
 * transaction, one history entry and one save, with stable ids — the panel
 * adds no mutation path of its own. Bypass is a toggle, like a strip's Mute,
 * so its state is `aria-pressed`, and a bypassed device keeps its place and
 * its settings; it only recedes. The actions are icon buttons, like the mixer
 * strip's, named for assistive technology and in their tooltips.
 * Reordering is not the card's: the chain panel owns the drag and the
 * keyboard moves, because both need the whole chain.
 */
export default function DeviceCard(props: DeviceCardProps): JSX.Element {
  const label = () => deviceTypeDefinition(props.device.type)?.label ?? props.device.type;
  const chain = () => props.chain;
  const run = (command: RawCommandInput) => props.dispatch(command);

  return (
    <article
      ref={control(() => controlAddress(props.device.id, CONTROL_PARTS.faceplate))}
      class={["device-card", { bypassed: props.device.bypassed }]}
    >
      {/* The header and the card's background are the drag handle; the name
          is the keyboard's, a sortable button that takes the registry's
          `device.move_earlier`/`device.move_later` (Alt/Option+Up/Down). */}
      <header class="device-card-head">
        <h4 class="device-card-name">
          <button
            type="button"
            class="device-card-grip"
            aria-roledescription="sortable"
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            title="Drag to reorder, or press Alt+Up or Alt+Down"
          >
            {label()}
          </button>
        </h4>
        <div class="device-card-actions">
          <button
            type="button"
            class={[
              "device-card-button device-bypass",
              { active: props.device.bypassed },
            ]}
            aria-pressed={ariaBool(props.device.bypassed)}
            aria-label={`Bypass ${label()}`}
            title="Bypass"
            onClick={() =>
              run(setDeviceBypass(chain(), props.device.id, !props.device.bypassed))
            }
          >
            <HiSolidPower size={13} />
          </button>
          <button
            type="button"
            class="device-card-button"
            aria-label={`Duplicate ${label()}`}
            title="Duplicate"
            disabled={!props.canDuplicate}
            onClick={() =>
              run(duplicateDevice(chain(), props.device.id, props.newDeviceId()))
            }
          >
            <HiSolidDocumentDuplicate size={13} />
          </button>
          <button
            type="button"
            class="device-card-button"
            aria-label={`Reset ${label()}`}
            title="Reset to defaults"
            onClick={() => run(resetDevice(chain(), props.device.id))}
          >
            <HiSolidArrowPath size={13} />
          </button>
          <button
            type="button"
            class="device-card-button device-remove"
            aria-label={`Remove ${label()}`}
            title="Remove"
            onClick={() => run(removeDevice(chain(), props.device.id))}
          >
            <HiSolidTrash size={13} />
          </button>
        </div>
      </header>
      {/* The EQ is played on its curve, so its faceplate is its own (LOOP-022). */}
      <Show
        when={props.device.type !== "eq"}
        fallback={
          <EqFaceplate
            chain={props.chain}
            device={props.device}
            dispatch={props.dispatch}
            beginGesture={props.beginGesture}
          />
        }
      >
        <div class={["device-card-body", { "with-well": hasDeviceWell(props.device) }]}>
          <Show when={hasDeviceWell(props.device)}>
            <DeviceWell
              chain={props.chain}
              tempo={props.tempo}
              device={props.device}
              dispatch={props.dispatch}
              beginGesture={props.beginGesture}
            />
          </Show>
          <DeviceControls
            chain={props.chain}
            tempo={props.tempo}
            device={props.device}
            dispatch={props.dispatch}
            beginGesture={props.beginGesture}
          />
        </div>
      </Show>
    </article>
  );
}
