import { For, type JSX, Show } from "@solidjs/web";
import { HiSolidPlus, HiSolidXMark } from "solid-icons/hi";
import {
  createControlGesture,
  type Gesture,
  type GestureOptions,
  type RawCommandInput,
  setParameter,
  type TransactionResult,
} from "../../commands";
import type { ReturnBus, Send, Track } from "../../domain/entities";
import { TRACK_SEND_LEVEL } from "../../domain/parameters";
import { formatReadout } from "../../domain/valueFormat";
import FillSlider from "../../instrument/FillSlider";
import { MASK_CONTENT } from "../../monitoring/replayPrivacy";

export interface TrackSendsProps {
  readonly track: Track;
  /** The song's returns, in order. */
  readonly returns: readonly ReturnBus[];
  onAddSend(returnBus: ReturnBus): void;
  onRemoveSend(returnBus: ReturnBus): void;
  /** Called once per landed level change, for first-use analytics. */
  onLevelCommit?(): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}

/**
 * A track's sends, one row per return on its mixer strip (#386). A return the
 * track does not send to offers a button that adds the send; one it does
 * shows the send's level, a drag of which is one gesture (one history entry,
 * one revision, one save), and a button that removes it.
 */
export default function TrackSends(props: TrackSendsProps): JSX.Element {
  const sendTo = (returnBus: ReturnBus): Send | undefined =>
    props.track.sendConfig.find((send) => send.returnId === returnBus.id);

  return (
    <Show when={props.returns.length > 0}>
      <ul class="mixer-strip-sends" aria-label={`Sends from ${props.track.name}`}>
        <For each={props.returns} keyed={(bus) => bus.id}>
          {(returnBus) => (
            <li class="mixer-send">
              <Show
                when={sendTo(returnBus())}
                fallback={
                  <button
                    type="button"
                    class="mixer-send-add"
                    aria-label={`Send ${props.track.name} to ${returnBus().name}`}
                    onClick={() => props.onAddSend(returnBus())}
                  >
                    <HiSolidPlus size={11} />
                    <span class={MASK_CONTENT}>{returnBus().name}</span>
                  </button>
                }
              >
                {(send) => (
                  <>
                    <div class="mixer-send-head">
                      <span class={`mixer-send-name ${MASK_CONTENT}`}>
                        {returnBus().name}
                      </span>
                      <button
                        type="button"
                        class="mixer-strip-action mixer-send-remove"
                        aria-label={`Remove send from ${props.track.name} to ${returnBus().name}`}
                        onClick={() => props.onRemoveSend(returnBus())}
                      >
                        <HiSolidXMark size={11} />
                      </button>
                    </div>
                    <SendLevel
                      track={props.track}
                      returnBus={returnBus()}
                      level={send().level}
                      onCommit={() => props.onLevelCommit?.()}
                      dispatch={props.dispatch}
                      beginGesture={props.beginGesture}
                    />
                  </>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function SendLevel(props: {
  readonly track: Track;
  readonly returnBus: ReturnBus;
  readonly level: number;
  onCommit(): void;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  beginGesture(options?: GestureOptions): Gesture | undefined;
}): JSX.Element {
  const control = createControlGesture({
    beginGesture: (options) => props.beginGesture(options),
    dispatch: (commands) => props.dispatch(commands),
    summary: () => `Set send from ${props.track.name} to ${props.returnBus.name}`,
    command: (value) =>
      setParameter(
        {
          scope: "send",
          trackId: props.track.id,
          returnId: props.returnBus.id,
          parameterId: TRACK_SEND_LEVEL.id,
        },
        value,
      ),
  });
  return (
    <FillSlider
      definition={TRACK_SEND_LEVEL}
      inputId={`mixer-send-${props.track.id}-${props.returnBus.id}`}
      label="Send"
      ariaLabel={`Send level from ${props.track.name} to ${props.returnBus.name}`}
      orientation="horizontal"
      value={props.level}
      displayValue={formatReadout(TRACK_SEND_LEVEL, props.level)}
      onInput={(value) => control.input(value)}
      onCommit={(value, settle) => {
        control.commit(value, settle);
        props.onCommit();
      }}
    />
  );
}
