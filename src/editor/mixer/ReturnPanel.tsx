import type { JSX } from "@solidjs/web";
import type { Analytics } from "../../analytics/analytics";
import {
  type Gesture,
  type GestureOptions,
  type RawCommandInput,
  returnChain,
  type TransactionResult,
} from "../../commands";
import type { Project, ReturnBus } from "../../domain/entities";
import type { IdFactory } from "../../domain/ids";
import { MASK_CONTENT } from "../../monitoring/replayPrivacy";
import { DeviceChain, type DeviceChainLabels } from "../devices/DeviceChainPanel";
import "./ReturnPanel.css";

export interface ReturnPanelProps {
  readonly project: Project;
  readonly returnBus: ReturnBus;
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
  region: "Return effects",
  list: "Return chain",
  empty:
    "Nothing on this return yet. Add a device, then send tracks to it from the mixer.",
};

/** How many tracks send to the return, in words. */
export function sendersLabel(project: Project, returnBus: ReturnBus): string {
  const count = project.song.tracks.filter((track) =>
    track.sendConfig.some((send) => send.returnId === returnBus.id),
  ).length;
  if (count === 0) return "No tracks send to it yet";
  return count === 1 ? "1 track sends to it" : `${count} tracks send to it`;
}

/**
 * A selected return's effects (#386), in the instrument view's return mode
 * and the mixer's chain slot (#1106): its
 * chain, on the same `DeviceChain` a track's inserts (#241) and the master's
 * (#283) use, so adding, editing, reordering, bypass, duplicate, reset and
 * failure reporting behave exactly alike. A return has no instrument, so there
 * is none here; like the master's, its chain is unbounded.
 */
export default function ReturnPanel(props: ReturnPanelProps): JSX.Element {
  return (
    <div class="instrument-view-track instrument-view-return">
      <header class="instrument-return-head">
        <p class="instrument-return-kind">Return</p>
        <h2 class={`instrument-return-name ${MASK_CONTENT}`}>{props.returnBus.name}</h2>
        <p class="instrument-return-senders">
          {sendersLabel(props.project, props.returnBus)}
        </p>
      </header>
      <DeviceChain
        chain={returnChain(props.returnBus.id)}
        devices={props.returnBus.devices}
        labels={LABELS}
        tempo={props.project.song.tempo}
        dispatch={props.dispatch}
        beginGesture={props.beginGesture}
        analytics={props.analytics}
        ids={props.ids}
      />
    </div>
  );
}
