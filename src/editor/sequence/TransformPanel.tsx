import { For, type JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import { bucketOf } from "../../analytics/buckets";
import {
  noteEventsOf,
  type RawCommandInput,
  type TransactionResult,
} from "../../commands";
import type { Clip, Project } from "../../domain/entities";
import { createFactoryContext } from "../../domain/factories";
import type { EventId } from "../../domain/ids";
import { canDouble } from "./doubleClip";
import { canHalve } from "./halveClip";
import {
  buildTransform,
  canTransform,
  DEFAULT_TRANSFORM_OPTIONS,
  formatSemitones,
  nudgeSemitones,
  parseSemitones,
  resolveTransformScope,
  TRANSFORM_LABELS,
  TRANSFORM_OPERATIONS,
  type TransformFallback,
  type TransformKind,
  type TransformOptions,
  transformedEventCount,
} from "./transformModel";
import "./TransformPanel.css";
import {
  blurValueField,
  type FocusedValueField,
  focusValueField,
} from "../composition/valueFieldFocus";

/** The transformations that act on the whole clip, whatever is selected. */
const CLIP_WIDE: ReadonlySet<TransformKind> = new Set(["duplicate", "halve", "clear"]);

/** Mints event IDs for the copies `notes.duplicate` creates (see StepEditor). */
const factoryContext = createFactoryContext();

export interface TransformPanelProps {
  readonly clip: Clip;
  readonly project: Project;
  /** The editor's current note selection; empty means "the whole clip". */
  readonly selectedIds: readonly EventId[];
  /** What an empty selection means instead, when not the whole clip (#643). */
  readonly fallback?: TransformFallback | null;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /** Which editor hosts the panel, for `clip_edited`'s `editor` parameter. */
  readonly editor: "step" | "piano_roll";
  /** Defaults to the application's singleton; injectable for tests. */
  readonly analytics?: Analytics;
}

/**
 * The Transform panel (CLP-04, ARR-010): transpose, vary timing, vary
 * velocity, quantize, quantize to scale, halve, double and clear, for the selection
 * or, with nothing selected, the whole clip.
 *
 * Every button dispatches registered commands — the same ones the assistant
 * calls — as one transaction and one undo step. Both Varies are random on
 * every press, from a seed minted per press and never shown, so undo and redo
 * replay them exactly (#653). A refusal changes nothing and says why under the buttons, in the
 * user's terms. Double acts on the whole clip: it doubles the clip and copies
 * every note into the new half (#647), refusing only at the longest clip
 * length. Quantize to scale is for pitched notes, so only the piano roll
 * shows it, and it is off while the song's key is chromatic.
 */
export default function TransformPanel(props: TransformPanelProps): JSX.Element {
  const analytics = () => props.analytics ?? defaultAnalytics;
  const [options, setOptions] = createSignal<TransformOptions>(DEFAULT_TRANSFORM_OPTIONS);
  const [error, setError] = createSignal<string | null>(null);

  const scope = createMemo(() =>
    resolveTransformScope(props.clip, props.selectedIds, props.fallback),
  );
  const enabled = createMemo(() => canTransform(scope()));
  // Double, Halve and Clear always act on the whole clip, so an empty row
  // must not switch them off.
  const clipHasNotes = () => (noteEventsOf(props.clip) ?? []).length > 0;
  const chromatic = () => props.project.song.key.scale === "chromatic";

  // A refusal describes the clip as it was when the user clicked, so once the
  // clip changes underneath it is dropped rather than left to mislead.
  createEffect(
    () => props.clip,
    () => {
      setError(null);
    },
    { defer: true },
  );

  function scopeLabel(): string {
    const { count, isWholeClip, rowName } = scope();
    if (count === 0) return rowName ? `No notes in ${rowName}` : "No notes";
    const noun = count === 1 ? "note" : "notes";
    if (rowName) return `All ${count} ${noun} in ${rowName}`;
    return isWholeClip ? `All ${count} ${noun}` : `${count} selected ${noun}`;
  }

  function refuse(kind: TransformKind): void {
    setError(rejectionMessage(kind));
    analytics().log("note_edit_failed", {
      operation: TRANSFORM_OPERATIONS[kind],
      error_code: "command_rejected",
    });
  }

  function applyTransform(kind: TransformKind): void {
    const current = scope();
    const clipWide = CLIP_WIDE.has(kind);
    if (clipWide ? !clipHasNotes() : !canTransform(current)) return;
    // Reaching for a transformation is the feature being used, accepted or not.
    analytics().logFeatureFirstUse(
      props.editor === "step" ? "step_editor" : "piano_roll",
    );
    if (kind === "duplicate" && !canDouble(props.clip)) {
      refuse(kind);
      return;
    }
    const command = buildTransform(kind, {
      project: props.project,
      clip: props.clip,
      scope: current,
      ids: factoryContext.ids,
      options: options(),
    });
    const count = transformedEventCount(kind, current, props.clip);
    const result = props.dispatch(
      command as RawCommandInput | readonly RawCommandInput[],
    );
    if (result && !result.ok) {
      refuse(kind);
      return;
    }
    setError(null);
    analytics().log("clip_edited", {
      editor: props.editor,
      event_count_bucket: bucketOf("event_count", count),
    });
  }

  function TransformButton(button: {
    kind: TransformKind;
    disabled?: boolean;
    /** As wide as a button and its field together: the first row's thirds. */
    wide?: boolean;
  }) {
    return (
      <button
        type="button"
        class={["transform-button", { "transform-wide": button.wide === true }]}
        onClick={() => applyTransform(button.kind)}
        disabled={
          !(CLIP_WIDE.has(button.kind) ? clipHasNotes() : enabled()) ||
          button.disabled === true
        }
      >
        {TRANSFORM_LABELS[button.kind]}
      </button>
    );
  }

  const buttons = (): readonly TransformKind[] =>
    props.editor === "piano_roll"
      ? ["quantize", "quantizeToScale", "halve", "duplicate", "clear"]
      : ["quantize", "halve", "duplicate", "clear"];

  /** Quantize to scale needs a key; Halve stops at one bar (#662). */
  const unavailable = (kind: TransformKind): boolean =>
    (kind === "quantizeToScale" && chromatic()) ||
    (kind === "halve" && !canHalve(props.clip));

  return (
    <section class="transform-panel" aria-label="Transform">
      <div class="transform-head">
        <span class="transform-title">Transform</span>
        <span class="transform-scope">{scopeLabel()}</span>
      </div>
      <div class="transform-grid">
        <div class="transform-pair">
          <TransformButton kind="transpose" />
          <ValueField
            label="Semitones"
            nudge={nudgeSemitones}
            display={formatSemitones(options().semitones)}
            parse={parseSemitones}
            onCommit={(semitones) => setOptions((c) => ({ ...c, semitones }))}
          />
        </div>
        <TransformButton kind="vary" wide />
        <TransformButton kind="varyVelocity" wide />
        {/* One full row, however many buttons the editor offers. */}
        <div class="transform-row">
          <For each={buttons()}>
            {(kind) => <TransformButton kind={kind} disabled={unavailable(kind)} />}
          </For>
        </div>
      </div>
      {/* A refusal is shown, not swallowed: nothing moved, and this says why. */}
      <p class="transform-error" role="alert">
        {error() ?? ""}
      </p>
    </section>
  );
}

/**
 * Why a transformation was refused, in the user's terms. The command layer's
 * own issue text names entity IDs and raw ticks — right for a log, wrong for a
 * person — so each known refusal gets a sentence that says what to change.
 */
function rejectionMessage(kind: TransformKind): string {
  switch (kind) {
    case "transpose":
      return "That would move a note outside the playable pitch range. Try fewer semitones.";
    case "duplicate":
      return "This clip is already as long as a clip can be, so it cannot double.";
    default:
      return "That transformation could not be applied to this clip.";
  }
}

/**
 * A value you can type into. Enter or leaving the field commits what was
 * typed; anything that does not read as a value is refused, flagged, and put
 * back to the last good one. While it has focus the shortcut registry's
 * ↑/↓ nudge it (see `valueFieldFocus.ts`), and Esc closes the dialog as
 * everywhere: the field never reads a key itself.
 */
function ValueField<T>(props: {
  readonly label: string;
  readonly display: string;
  parse(text: string): T | null;
  nudge(value: T, direction: 1 | -1): T;
  onCommit(value: T): void;
}): JSX.Element {
  const [invalid, setInvalid] = createSignal(false);
  let input: HTMLInputElement | undefined;

  function commit(text: string): void {
    const value = props.parse(text);
    setInvalid(value === null);
    if (value !== null) props.onCommit(value);
    // Either the committed value, formatted, or the last good one.
    queueMicrotask(() => {
      if (input) input.value = props.display;
    });
  }

  const field: FocusedValueField = {
    nudge(direction) {
      // From what is typed if it reads as a value, else from the last good one.
      const current = props.parse(input?.value ?? "") ?? props.parse(props.display);
      if (current !== null) props.onCommit(props.nudge(current, direction));
      setInvalid(false);
      queueMicrotask(() => {
        if (!input) return;
        input.value = props.display;
        input.select();
      });
    },
  };
  // A dialog closed with the field focused removes it without a blur, so the
  // field lets go of the keys when it unmounts too.
  onCleanup(() => blurValueField(field));

  return (
    <input
      ref={input}
      type="text"
      class="transform-value"
      aria-label={props.label}
      aria-invalid={invalid() ? "true" : undefined}
      spellcheck={false}
      autocomplete="off"
      value={props.display}
      onFocus={(event) => {
        event.currentTarget.select();
        focusValueField(field);
      }}
      onBlur={() => blurValueField(field)}
      onChange={(event) => commit(event.currentTarget.value)}
    />
  );
}
