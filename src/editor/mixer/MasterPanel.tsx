import type { JSX } from "@solidjs/web";
import type { Analytics } from "../../analytics/analytics";
import {
  type Gesture,
  type GestureOptions,
  masterChain,
  type RawCommandInput,
  type TransactionResult,
} from "../../commands";
import type { Project } from "../../domain/entities";
import type { IdFactory } from "../../domain/ids";
import { DeviceChain, type DeviceChainLabels } from "../devices/DeviceChainPanel";

export interface MasterPanelProps {
  readonly project: Project;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** Defaults to the application singleton; injectable for tests. */
  readonly analytics?: Analytics;
  /** Where new device ids come from; injectable so a test is deterministic. */
  readonly ids?: IdFactory;
  /** Receives the panel's region, so the master strip can move focus to it. */
  sectionRef?(element: HTMLElement): void;
}

const LABELS: DeviceChainLabels = {
  region: "Master effects",
  heading: "Master",
  list: "Master chain",
  empty: "Nothing on the master yet. Add a device to process the whole mix.",
};

/**
 * The master FX panel (PRD FX-01, section 6; LOOP-020): the same device chain
 * a track's inserts use (#241), addressed to the master. Adding, editing,
 * dragging and Alt+Up/Down reordering, bypass, reset, duplicate, remove and
 * failure reporting are therefore identical on both; the master's chain is
 * simply unbounded, because the domain sets no limit on it.
 *
 * The master is the right first chain to reach: it always exists, needs no
 * selection model, and putting one effect across everything you have made is
 * the move that most changes how a loop sounds.
 */
export default function MasterPanel(props: MasterPanelProps): JSX.Element {
  return (
    <DeviceChain
      chain={masterChain}
      devices={props.project.song.master.devices}
      labels={LABELS}
      tempo={props.project.song.tempo}
      dispatch={props.dispatch}
      beginGesture={props.beginGesture}
      analytics={props.analytics}
      ids={props.ids}
      sectionRef={props.sectionRef}
    />
  );
}
