import { type JSX, Show } from "@solidjs/web";
import { HiSolidTrash } from "solid-icons/hi";
import {
  createControlGesture,
  type Gesture,
  type GestureOptions,
  type RawCommandInput,
  setParameter,
  type TransactionResult,
  updateReturn,
} from "../../commands";
import type { ReturnBus } from "../../domain/entities";
import { formatPan } from "../../domain/faders";
import { RETURN_PAN, RETURN_VOLUME } from "../../domain/parameters";
import FillSlider from "../../instrument/FillSlider";
import { MASK_CONTENT } from "../../monitoring/replayPrivacy";
import { ariaBool } from "../../shared/aria";
import { useShortcutScope } from "../../shortcuts";
import { MAX_DISPLAY_NAME_LENGTH } from "../composition/displayNameLimit";
import { chainSummary } from "./MasterStrip";
import { DbFader } from "./TrackFaders";

export interface ReturnStripProps {
  readonly returnBus: ReturnBus;
  /** Whether this return is the one the instrument view is showing. */
  readonly selected: boolean;
  /**
   * Points the editor at this return: the instrument view shows its chain.
   * With none, the strip has no Edit control, since there is nowhere to go.
   */
  onSelect?(): void;
  onDelete(): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/**
 * One return bus as a channel strip (#386): its name, typed in place; the way
 * to its effects chain; its pan and its volume, each one gesture per drag; the
 * chain it carries, by name; and its delete, which takes every send to it along
 * in the same undoable transaction.
 */
export default function ReturnStrip(props: ReturnStripProps): JSX.Element {
  const name = () => props.returnBus.name;
  return (
    <li class={["mixer-strip", "mixer-return-strip", { selected: props.selected }]}>
      <div class="mixer-strip-head">
        <ReturnNameInput returnBus={props.returnBus} dispatch={props.dispatch} />
        <Show when={props.onSelect}>
          {(select) => (
            <button
              type="button"
              class="mixer-strip-select"
              aria-pressed={ariaBool(props.selected)}
              aria-label={`Edit ${name()}`}
              title={`Edit ${name()}`}
              onClick={() => select()()}
            >
              Return
            </button>
          )}
        </Show>
      </div>
      <div class="mixer-strip-pan">
        <ReturnPan
          returnBus={props.returnBus}
          dispatch={props.dispatch}
          beginGesture={props.beginGesture}
        />
      </div>
      <div class="mixer-strip-controls">
        <DbFader
          definition={RETURN_VOLUME}
          target={{
            scope: "return",
            returnId: props.returnBus.id,
            parameterId: RETURN_VOLUME.id,
          }}
          value={props.returnBus.mixer.volume}
          inputId={`mixer-volume-${props.returnBus.id}`}
          ariaLabel={`Volume for ${name()}`}
          summary={`Set volume for return ${name()}`}
          dispatch={props.dispatch}
          beginGesture={props.beginGesture}
        />
      </div>
      <div class="mixer-strip-actions">
        <span class="mixer-strip-chain" title={chainSummary(props.returnBus.devices)}>
          {chainSummary(props.returnBus.devices)}
        </span>
        <button
          type="button"
          class="mixer-strip-action mixer-delete"
          aria-label={`Delete ${name()}`}
          onClick={() => props.onDelete()}
        >
          <HiSolidTrash size={13} />
        </button>
      </div>
    </li>
  );
}

function ReturnPan(props: {
  readonly returnBus: ReturnBus;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}): JSX.Element {
  const control = createControlGesture({
    beginGesture: (options) => props.beginGesture(options),
    dispatch: (commands) => props.dispatch(commands),
    summary: () => `Set pan for return ${props.returnBus.name}`,
    command: (value) =>
      setParameter(
        { scope: "return", returnId: props.returnBus.id, parameterId: RETURN_PAN.id },
        value,
      ),
  });
  return (
    <FillSlider
      definition={RETURN_PAN}
      inputId={`mixer-pan-${props.returnBus.id}`}
      label="Pan"
      ariaLabel={`Pan for ${props.returnBus.name}`}
      orientation="horizontal"
      bipolar
      range={{ min: RETURN_PAN.min, max: RETURN_PAN.max, step: 0.01 }}
      resetValue={RETURN_PAN.defaultValue}
      value={props.returnBus.mixer.pan}
      displayValue={formatPan(props.returnBus.mixer.pan)}
      onInput={(value) => control.input(value)}
      onCommit={(value, settle) => control.commit(value, settle)}
    />
  );
}

/**
 * A return's name, typed in place, as a track's is (`TrackNameInput`): a
 * change commits one `return.update`; an empty or unchanged name puts the
 * return's own back. Escape, while the name has focus, is the registry's
 * `view.close_surface`: it puts the return's own name back and blurs, so no
 * change event fires and nothing is committed.
 */
function ReturnNameInput(props: {
  readonly returnBus: ReturnBus;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
}): JSX.Element {
  let input: HTMLInputElement | undefined;
  useShortcutScope({
    handlers: () => ({
      "view.close_surface": {
        run: () => {
          if (!input) return;
          input.value = props.returnBus.name;
          input.blur();
        },
        isEnabled: () => input !== undefined && document.activeElement === input,
      },
    }),
    contexts: () => [],
  });

  return (
    <input
      ref={input}
      id={`return-name-${props.returnBus.id}`}
      class={`mixer-strip-name ${MASK_CONTENT}`}
      type="text"
      maxlength={MAX_DISPLAY_NAME_LENGTH}
      aria-label="Return name"
      value={props.returnBus.name}
      onChange={(event) => {
        const name = event.currentTarget.value.trim();
        if (name && name !== props.returnBus.name) {
          props.dispatch(updateReturn(props.returnBus.id, { name }));
        } else {
          event.currentTarget.value = props.returnBus.name;
        }
      }}
    />
  );
}
