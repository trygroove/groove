import { For, type JSX, Show } from "@solidjs/web";
import { HiSolidPlus } from "solid-icons/hi";
import { createSignal } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import type { DeviceOperation, FeatureKey } from "../analytics/catalog";
import type { ErrorCode } from "../analytics/errorCodes";
import {
  addDevice,
  type CommandIssueCode,
  type DeviceChainTarget,
  type Gesture,
  type GestureOptions,
  insertChain,
  newDeviceOrder,
  type RawCommandInput,
  reorderDevice,
  type TransactionResult,
} from "../commands";
import { createDevice, type DeviceTypeId, deviceTypes } from "../domain/devices";
import type { Device, Track } from "../domain/entities";
import { createIdFactory, type DeviceId, type IdFactory } from "../domain/ids";
import { MAX_TRACK_INSERTS } from "../domain/parse";
import type { ShortcutHandlers } from "../shortcuts/ShortcutController";
import { useShortcutScope } from "../shortcuts/useShortcutScope";
import DeviceCard from "./DeviceCard";
import "./NewTrackButtons.css";
import { previewOrder } from "./trackReorder";
import { useTrackDrag } from "./useTrackDrag";
import "./DeviceChainPanel.css";

/** What a chain is called, to a screen reader and on screen. */
export interface DeviceChainLabels {
  /** The panel's region. */
  readonly region: string;
  /** A visible title, when the chain needs one: the master's does, while a
   * track's sits under its instrument and needs none (#447). */
  readonly heading?: string;
  /** The ordered list of devices. */
  readonly list: string;
  /** Shown while the chain is empty. */
  readonly empty?: string;
}

export interface DeviceChainProps {
  /** Which chain this is: the address every `device.*` command carries. */
  readonly chain: DeviceChainTarget;
  readonly devices: readonly Device[];
  readonly labels: DeviceChainLabels;
  /**
   * The most devices the chain may hold, and what to say once it does. Adding
   * and duplicating stop there. A chain the domain does not bound has none.
   */
  readonly limit?: { readonly count: number; readonly note: string };
  /**
   * Receives the chain's region, so a host can move focus to it — the mixer's
   * master strip does. Given one, the region is focusable.
   */
  sectionRef?(element: HTMLElement): void;
  /** The song's tempo, so a synced delay's well draws its real echo times. */
  readonly tempo?: number;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** Defaults to the application singleton; injectable for tests. */
  readonly analytics?: Analytics;
  /** Where new device ids come from; injectable so a test is deterministic. */
  readonly ids?: IdFactory;
}

const defaultIds = createIdFactory();

/**
 * Where a press does not start a drag: the card's own controls, its well's
 * drag surface included (it is `aria-hidden`, so it carries no role). The name
 * is a button only for the keyboard, so it stays part of the handle.
 */
const NOT_A_HANDLE =
  "button:not(.device-card-grip), input, select, textarea, label, [role='slider'], [role='radio'], .drag-surface";

/**
 * One device chain (PRD FX-01): a track's inserts (#241, `DeviceChainPanel`)
 * or the master's (#283, `MasterPanel`). Both chains are this one component,
 * so they add, edit, reorder and report exactly alike; only their address,
 * their names and whether they are bounded differ.
 *
 * The chain is a named, ordered list, in signal order, each entry a
 * `DeviceCard`. Below the last device sits one add button per registered
 * type, the same unit the arrangement and the mixer use for adding a track
 * (`NewTrackButtons`): a button per kind makes the type the click itself
 * rather than a picker opened first. Each appends one fully defaulted device
 * through `device.add`: one transaction, one undo,
 * one save, and one `device_added` — plus the account's first
 * `feature_first_use` for `device_chain`. A bounded chain stops adding and
 * duplicating at its `limit` rather than offering a command the domain will
 * refuse.
 *
 * Reordering is a drag from a card's header or background into a slot above
 * or below another card — the card is picked up, a copy following the pointer,
 * and the chain previews the new order while it is held, every slot including
 * the one it started in; a drop outside the chain, or Escape, leaves it as it
 * was — or Alt/Option+Up/Down on a focused device
 * name (the registry's `device.move_*`). Each move is one `device.reorder`,
 * and `DeviceChain` relinks the audio without rebuilding a node, so a move
 * during playback is click-free.
 *
 * A refused edit is the chain's principal failure, so it is reported rather
 * than swallowed: `device_edit_failed`, with the operation and a stable code
 * and no chain, track, project or device identity.
 *
 * Cards are keyed on the device's id, not its object: every parameter edit
 * produces a new device object, and a card rebuilt under a live drag would
 * lose the very slider the pointer is moving.
 */
export function DeviceChain(props: DeviceChainProps): JSX.Element {
  const ids = () => props.ids ?? defaultIds;
  const analytics = () => props.analytics ?? defaultAnalytics;
  const devices = () => [...props.devices].sort((a, b) => a.order - b.order);
  const full = () => props.limit !== undefined && devices().length >= props.limit.count;

  /** Every chain edit, the cards' included, reporting the ones refused. */
  function edit(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined {
    const result = props.dispatch(commands);
    if (result?.ok) return result;
    const first = Array.isArray(commands) ? commands[0] : commands;
    const operation = DEVICE_OPERATION_BY_COMMAND[(first as RawCommandInput)?.type];
    if (operation) {
      analytics().log("device_edit_failed", {
        operation,
        error_code: errorCodeOf(result),
      });
    }
    return result;
  }
  let list: HTMLOListElement | undefined;
  // The card is picked up (#539, `useTrackDrag`): a copy follows the pointer and
  // its own slot is the gap. Nothing is committed until it is let go over the
  // chain, and then it is one `device.reorder`.
  const drag = useTrackDrag<DeviceId>({
    axis: "y",
    zone: () => list,
    indexOf: (id) => devices().findIndex((device) => device.id === id),
    onDrop: (id, to) => move(id, to),
  });

  /**
   * Where each device shows while a drag is previewed: the chain as it would
   * read after the drop, applied as a flex `order` so no node moves under the
   * pointer.
   */
  function shownAt(id: DeviceId, index: number): number {
    const held = drag.dragging();
    const to = drag.target();
    if (held === null || to === null) return index;
    return previewOrder(
      devices().map((device) => device.id),
      (entry) => entry === held,
      to,
    ).indexOf(id);
  }

  const [focused, setFocused] = createSignal<DeviceId | null>(null);

  function move(id: DeviceId, to: number): void {
    edit(reorderDevice(props.chain, id, to));
  }

  /** The focused device's index, and whether it can go `step` places. */
  function focusedMove(step: -1 | 1): { id: DeviceId; to: number } | undefined {
    const id = focused();
    const from = devices().findIndex((device) => device.id === id);
    if (id === null || from < 0) return undefined;
    const to = from + step;
    return to >= 0 && to < devices().length ? { id, to } : undefined;
  }

  function moveFocused(step: -1 | 1): void {
    const target = focusedMove(step);
    if (!target) return;
    // The list is keyed by id, so the same node moves; moving it can drop
    // focus, so put focus back on it once the list has settled.
    const grip = document.activeElement as HTMLElement | null;
    move(target.id, target.to);
    queueMicrotask(() => grip?.focus());
  }

  useShortcutScope({
    handlers: (): ShortcutHandlers => ({
      "device.move_earlier": {
        run: () => moveFocused(-1),
        isEnabled: () => focusedMove(-1) !== undefined,
      },
      "device.move_later": {
        run: () => moveFocused(1),
        isEnabled: () => focusedMove(1) !== undefined,
      },
    }),
    contexts: () => ["editor"],
  });

  function add(type: DeviceTypeId): void {
    const device = createDevice(
      ids()("device"),
      type,
      newDeviceOrder(props.chain, devices()),
    );
    const result = edit(addDevice(props.chain, device));
    if (!result?.ok) return;
    analytics().log("device_added", { device_type: type, chain: props.chain.chain });
    analytics().logFeatureFirstUse("device_chain");
    const feature = DEVICE_FIRST_USE[type];
    if (feature) analytics().logFeatureFirstUse(feature);
  }

  return (
    <section
      ref={(element) => props.sectionRef?.(element)}
      class="device-chain"
      aria-label={props.labels.region}
      tabindex={props.sectionRef ? "-1" : undefined}
    >
      <Show when={props.labels.heading}>
        {(heading) => (
          <header class="device-chain-head">
            <h3 class="device-chain-heading">{heading()}</h3>
          </header>
        )}
      </Show>
      {/* An empty track chain says nothing: the add buttons below are the
          invitation. The master's chain still explains itself (#447). */}
      <Show when={devices().length === 0 && props.labels.empty}>
        {(empty) => <p class="device-chain-note">{empty()}</p>}
      </Show>
      <ol ref={list} class="device-chain-list" aria-label={props.labels.list}>
        <For each={devices()} keyed={(device) => device.id}>
          {(device, index) => (
            <li
              class={["device-chain-item", { dragging: drag.dragging() === device().id }]}
              data-track-drag={device().id}
              style={{ order: shownAt(device().id, index()) }}
              onPointerDown={(event) => {
                // A card's controls keep their own gestures, so a slider drag
                // never becomes a card drag.
                const target = event.target as Element;
                if (target.closest(NOT_A_HANDLE) === null) drag.begin(event, device().id);
              }}
              onFocusIn={(event) => {
                const grip = (event.target as Element).closest(".device-card-grip");
                setFocused(grip ? device().id : null);
              }}
              onFocusOut={() => setFocused(null)}
            >
              <DeviceCard
                chain={props.chain}
                device={device()}
                canDuplicate={!full()}
                newDeviceId={() => ids()("device")}
                tempo={props.tempo}
                dispatch={edit}
                beginGesture={props.beginGesture}
              />
            </li>
          )}
        </For>
      </ol>
      <fieldset class="new-track-buttons device-chain-adds" aria-label="Add device">
        <For each={deviceTypes()}>
          {(definition) => {
            const action = `Add ${definition.label.toLowerCase()} device`;
            return (
              <button
                type="button"
                class="new-track-button"
                aria-label={action}
                title={action}
                disabled={full()}
                onClick={() => add(definition.type)}
              >
                <HiSolidPlus size={13} />
                <span>{definition.label}</span>
              </button>
            );
          }}
        </For>
      </fieldset>
      <Show when={full() && props.limit}>
        {(limit) => <p class="device-chain-note">{limit().note}</p>}
      </Show>
    </section>
  );
}

/**
 * A device type that is a feature of its own, measured by its own
 * `feature_first_use` on top of the chain's (PRD OPS-02): the EQ (LOOP-022).
 */
const DEVICE_FIRST_USE: Partial<Record<DeviceTypeId, FeatureKey>> = {
  eq: "eq_device",
  limiter: "limiter_device",
};

/** Which `device.*` command is which reportable edit. */
const DEVICE_OPERATION_BY_COMMAND: Readonly<Record<string, DeviceOperation>> = {
  "device.add": "add",
  "device.remove": "remove",
  "device.reorder": "reorder",
  "device.duplicate": "duplicate",
  "device.setBypass": "bypass",
  "device.reset": "reset",
};

/**
 * `revision_conflict` is the one refusal that is not the chain's bug — the
 * project moved on underneath it. Anything else means the chain offered an
 * edit the project could not satisfy, which is `internal`.
 */
function errorCodeOf(result: TransactionResult | undefined): ErrorCode {
  if (!result || result.ok) return "unknown";
  const code: CommandIssueCode | undefined = result.issues[0]?.code;
  return code === "revision_conflict" ? "revision_conflict" : "internal";
}

export interface DeviceChainPanelProps {
  /** The selected track (#240): the panel has no selection of its own. */
  readonly track: Track;
  /** The song's tempo, so a synced delay's well draws its real echo times. */
  readonly tempo?: number;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** Defaults to the application singleton; injectable for tests. */
  readonly analytics?: Analytics;
  /** Where new device ids come from; injectable so a test is deterministic. */
  readonly ids?: IdFactory;
}

const LABELS: DeviceChainLabels = {
  region: "Device chain",
  list: "Device chain",
};

const LIMIT = {
  count: MAX_TRACK_INSERTS,
  note: `A track holds up to ${MAX_TRACK_INSERTS} devices. Remove one to add another.`,
};

/**
 * The selected track's insert chain (#241, PRD FX-01), in the slot UI-001
 * reserved for it in the Instrument view: the shared `DeviceChain`, addressed
 * to the track and bounded at `MAX_TRACK_INSERTS`.
 */
export default function DeviceChainPanel(props: DeviceChainPanelProps): JSX.Element {
  return (
    <DeviceChain
      chain={insertChain(props.track.id)}
      devices={props.track.devices}
      labels={LABELS}
      limit={LIMIT}
      tempo={props.tempo}
      dispatch={props.dispatch}
      beginGesture={props.beginGesture}
      analytics={props.analytics}
      ids={props.ids}
    />
  );
}
