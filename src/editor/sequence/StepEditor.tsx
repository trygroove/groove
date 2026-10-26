import { For, type JSX, Show } from "@solidjs/web";
import { HiSolidPlus } from "solid-icons/hi";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import type { Gesture, GestureOptions, RawCommandInput } from "../../commands";
import { MAX_DRUM_PADS, removeNotes } from "../../commands";
import { CONTROL_PARTS, controlAddress } from "../../commands/controlAddress";
import { control } from "../../controls/control";
import type {
  Clip,
  Instrument,
  NoteEvent,
  NoteTrigger,
  Project,
} from "../../domain/entities";
import { createFactoryContext } from "../../domain/factories";
import type { EventId, PadId } from "../../domain/ids";
import { NOTE_VELOCITY } from "../../domain/parameters";
import { TICKS_PER_SIXTEENTH } from "../../domain/time";
import { clampZoom, stepWidth, ZOOM_FACTOR } from "../pianoRoll/layout";
import Ruler from "../pianoRoll/Ruler";
import Toolbar from "../pianoRoll/Toolbar";
import VelocityLane from "../pianoRoll/VelocityLane";
import ClipLengthControl from "./ClipLengthControl";
import type { RowPreview } from "./generatedRow";
import {
  eventCountBucket,
  isBarStart,
  isShadedBeat,
  lanesFor,
  noteAt,
  noteEventsOf,
  reuseLanes,
  type StepLane,
  selectedLane,
  stepCount,
  stepStartTicks,
  triggersMatch,
} from "./stepEditorModel";
import { useStepPointer } from "./stepPointer";
import { createStroke } from "./stepStroke";
import "../tracks/NewTrackButtons.css";
import "./StepEditor.css";
import { ariaBool } from "../../shared/aria";
import { detectPlatform } from "../../shortcuts/keys";

/**
 * Mints note-event IDs for notes the editor paints. A module singleton, not
 * per-render, so two strokes in the same session never collide.
 */
const factoryContext = createFactoryContext();

export interface StepEditorProps {
  readonly clip: Clip;
  /** The project, for edits that reach past the clip (its Bars control, #963). */
  readonly project: Project;
  /** The owning track's instrument, used to derive the lanes (CLP-02). */
  readonly instrument: Instrument | null;
  /** Single, immediately-committed edits (velocity, resize). */
  dispatch(commands: RawCommandInput | readonly RawCommandInput[]): unknown;
  /** Opens a paint/erase stroke that commits as one history entry. */
  beginGesture(options?: GestureOptions): Gesture | undefined;
  /** The step the playhead is over while playing, or null. */
  readonly playbackStep?: () => number | null;
  /** Whether the transport runs, and how the toolbar's Play toggles it. */
  readonly playing?: boolean;
  onTogglePlay?(): void;
  /** Whether the clip's track is soloed, and how the toolbar's Solo toggles it (#657). */
  readonly soloed?: boolean;
  onToggleSolo?(): void;
  /**
   * Controlled selection: the set of selected note ids and its setter. Lifted
   * to the parent so the editor's `edit.delete` shortcut (owned by
   * `EditorView`) can act on the same selection the grid renders. Optional —
   * when omitted the editor manages selection internally.
   */
  readonly selectedIds?: Accessor<readonly EventId[]>;
  readonly setSelectedIds?: (next: readonly EventId[]) => void;
  /**
   * The selected row's pad, when the host owns it (#643): the drum machine
   * panel's selected pad is the same selection. Held here when omitted.
   */
  readonly selectedPadId?: PadId | null;
  onSelectPad?(padId: PadId): void;
  /** Plays one pad, as its row is picked. */
  auditionPad?(padId: PadId): void;
  /**
   * What a hovered Generate panel generator would do to the selected row
   * (#643): steps it adds are hatched, notes it removes fade.
   */
  readonly preview?: RowPreview | null;
  /**
   * Offers the [+ Pad] row under a drum machine's last lane (#947), which
   * opens the library to choose the new pad's sound. Omitted, no row.
   */
  onAddPad?(): void;
  /** Defaults to the application singleton; injectable for tests. */
  readonly analytics?: Analytics;
}

/**
 * The CLP-02 step editor: a 1-32 bar, 16th-note grid for sampler and
 * drum-machine clips. Replaces the `FND-009` slice's minimal 16-step
 * `StepGrid`.
 *
 * Every project mutation goes through the shared command layer (PRD section
 * 9.6): a click toggles one step as one `CommandHistory` entry. A drag is a
 * lasso, as in the piano roll (#643), and only selects. Velocity and
 * clip-length edits are single committed commands.
 */
export default function StepEditor(props: StepEditorProps): JSX.Element {
  const analytics = () => props.analytics ?? defaultAnalytics;
  const lanes = createMemo((previous?: readonly StepLane[]) =>
    reuseLanes(previous, lanesFor(props.instrument)),
  );
  // The [+ Pad] row (#947): only a drum machine's lanes are pads to add to.
  const addPad = () =>
    props.instrument?.kind === "drumMachine" ? props.onAddPad : undefined;
  const kitFull = () => lanes().length >= MAX_DRUM_PADS;
  const steps = createMemo(() =>
    Array.from({ length: stepCount(props.clip) }, (_, index) => index),
  );

  // The selected row (#643): the target of the Generate panel and the rows
  // the velocity lane shows. On a drum machine it is the selected pad, shared
  // with the drum machine panel; painting a cell never moves it.
  const [ownRow, setOwnRow] = createSignal<string | null>(null);
  const row = createMemo(() =>
    selectedLane(
      lanes(),
      props.selectedPadId !== undefined ? props.selectedPadId : ownRow(),
    ),
  );
  function selectRow(lane: StepLane): void {
    setOwnRow(lane.key);
    if (lane.trigger.kind !== "pad") return;
    props.onSelectPad?.(lane.trigger.padId);
    audition(lane);
  }

  // What is only a view, as in the piano roll (ARR-010): preview and zoom.
  const [preview, setPreview] = createSignal(true);
  const [zoom, setZoom] = createSignal(1);
  const width = () => stepWidth(zoom());
  /** Plays a row's pad, while Preview sound is on. */
  function audition(lane: StepLane): void {
    if (preview() && lane.trigger.kind === "pad") props.auditionPad?.(lane.trigger.padId);
  }
  // The velocity lane shows the selected row's notes and nothing else (#643).

  // Selection is UI-only state (PRD 9.2) — it points at notes by their stable
  // event id and never mutates the project. Controlled by the parent when it
  // supplies the accessor/setter (so the `edit.delete` shortcut shares it),
  // otherwise managed here.
  const internalSelection = createSignal<readonly EventId[]>([]);
  const selectedIds = (): readonly EventId[] =>
    props.selectedIds?.() ?? internalSelection[0]();
  const setSelectedIds = (
    next: readonly EventId[] | ((prev: readonly EventId[]) => readonly EventId[]),
  ): void => {
    const value = typeof next === "function" ? next(selectedIds()) : next;
    if (props.setSelectedIds) {
      props.setSelectedIds(value);
    } else {
      internalSelection[1](value);
    }
  };
  const isSelected = (id: EventId): boolean => selectedIds().includes(id);
  const selectOnly = (id: EventId): void => setSelectedIds([id]);
  const deselect = (id: EventId): void =>
    setSelectedIds((ids) => ids.filter((existing) => existing !== id));
  const toggleSelected = (id: EventId): void =>
    setSelectedIds((ids) =>
      ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id],
    );

  const selectedSet = createMemo<ReadonlySet<EventId>>(() => new Set(selectedIds()));

  // The velocity lane shows what a Vary would change (#643): the selected
  // notes, from every row, or the selected row's when nothing is selected.
  const velocityNotes = createMemo(() => {
    const notes = noteEventsOf(props.clip);
    const selected = selectedSet();
    if (selected.size > 0) return notes.filter((note) => selected.has(note.id));
    const trigger = row()?.trigger;
    if (!trigger) return [];
    return notes.filter((note) => triggersMatch(note.trigger, trigger));
  });

  function noteForCell(lane: StepLane, step: number): NoteEvent | undefined {
    return noteAt(props.clip, lane, step);
  }

  function newNote(lane: StepLane, step: number): NoteEvent {
    audition(lane);
    return {
      id: factoryContext.ids("event"),
      trigger: lane.trigger satisfies NoteTrigger,
      startTicks: stepStartTicks(step) as NoteEvent["startTicks"],
      durationTicks: TICKS_PER_SIXTEENTH as NoteEvent["durationTicks"],
      velocity: NOTE_VELOCITY.defaultValue as NoteEvent["velocity"],
      probability: null,
    };
  }

  // The active paint/erase stroke, if a pointer is down. Held outside Solid's
  // reactive graph: it is imperative gesture bookkeeping, not rendered state.
  // The machine itself lives in `stepStroke.ts`; this component supplies the
  // seam it reads the clip, the gesture kernel, and the selection through.
  const stroke = createStroke({
    get clipId() {
      return props.clip.id;
    },
    beginGesture: (options) => props.beginGesture(options),
    noteAt: noteForCell,
    newNote,
    analytics,
    onNoteAdded: (id) => selectOnly(id),
    onNoteRemoved: (id) => deselect(id),
  });

  // --- Pointer handling ---------------------------------------------------
  //
  // The piano roll's rule (#643): a click toggles a step, a drag lassos notes.
  // Shift-click on a note selects it instead of erasing it.
  let lanesElement: HTMLDivElement | undefined;
  const pointer = useStepPointer({
    lanes: () => lanesElement,
    laneList: lanes,
    notes: () => noteEventsOf(props.clip),
    stepWidth: width,
    selected: selectedIds,
    setSelected: (ids) => setSelectedIds(ids),
    click(lane, step, add) {
      const existing = noteForCell(lane, step);
      if (add && existing) {
        toggleSelected(existing.id);
        return;
      }
      stroke.begin(lane, step);
      stroke.end();
    },
    platform: detectPlatform(),
  });

  const currentPlaybackStep = () => props.playbackStep?.() ?? null;

  function deleteSelection(): void {
    deleteSelectedNotes(props.clip, selectedIds(), props.dispatch);
    setSelectedIds([]);
  }

  return (
    <section
      class="step-editor"
      aria-label="Step editor"
      onPointerMove={(event) => pointer.move(event)}
      onPointerUp={() => pointer.up()}
      onPointerCancel={() => pointer.cancel()}
      onPointerLeave={() => pointer.leave()}
    >
      <Toolbar
        leading={
          <ClipLengthControl
            clip={props.clip}
            project={props.project}
            dispatch={props.dispatch}
            analytics={props.analytics}
          />
        }
        selectionCount={selectedIds().length}
        onSelectAll={() =>
          setSelectedIds(noteEventsOf(props.clip).map((note) => note.id))
        }
        onDelete={deleteSelection}
        preview={preview()}
        onTogglePreview={() => setPreview((on) => !on)}
        soloed={props.soloed ?? false}
        onToggleSolo={() => props.onToggleSolo?.()}
        zoom={zoom()}
        onZoomIn={() => setZoom((z) => clampZoom(z * ZOOM_FACTOR))}
        onZoomOut={() => setZoom((z) => clampZoom(z / ZOOM_FACTOR))}
        playing={props.playing ?? false}
        onTogglePlay={() => props.onTogglePlay?.()}
      />
      <div
        // The clip's notes as a control (`UI-004`): what a note edit reveals
        // and outlines.
        ref={control(() => controlAddress(props.clip.id, CONTROL_PARTS.notes))}
        class="step-editor-grid"
        style={{
          "--step-count": String(stepCount(props.clip)),
          "--pr-step": `${width()}px`,
          "--step-lane-count": String(lanes().length),
          // The ground keeps a row free under the last lane for [+ Pad].
          "--step-floor": String(Math.max(5, lanes().length + (addPad() ? 1 : 0))),
        }}
      >
        <div class="step-corner" />
        <Ruler steps={stepCount(props.clip)} stepWidth={width()} />
        {/* The row names, one button per pad: clicking one picks the row. */}
        <fieldset class="step-rows" aria-label="Rows">
          <For each={lanes()}>
            {(lane) => (
              <button
                type="button"
                class="step-row-name"
                title={lane.name}
                aria-pressed={ariaBool(row()?.key === lane.key)}
                onClick={() => selectRow(lane)}
              >
                {lane.name}
              </button>
            )}
          </For>
        </fieldset>
        <div
          class="step-lanes"
          ref={lanesElement}
          onPointerDown={(event) => {
            // A cell's own press already started; this is the empty ground.
            if (!(event.target as Element).closest(".step-cell")) pointer.down(event);
          }}
        >
          <For each={lanes()}>
            {(lane) => (
              <fieldset
                class="step-lane"
                aria-label={`Lane ${lane.name}`}
                aria-current={row()?.key === lane.key ? "true" : undefined}
              >
                <For each={steps()}>
                  {(step) => {
                    const note = () => noteForCell(lane, step);
                    const active = () => note() !== undefined;
                    const selected = () => {
                      const current = note();
                      return current ? isSelected(current.id) : false;
                    };
                    const playing = () => currentPlaybackStep() === step;
                    const ghost = () =>
                      row()?.key === lane.key && !!props.preview?.added.has(step);
                    const fading = () => {
                      const current = note();
                      return !!current && !!props.preview?.removed.has(current.id);
                    };
                    return (
                      <button
                        type="button"
                        class={[
                          "step-cell",
                          {
                            active: active(),
                            selected: selected(),
                            playing: playing(),
                            "bar-start": isBarStart(step),
                            shade: isShadedBeat(step),
                            ghost: ghost(),
                            fading: fading(),
                          },
                        ]}
                        aria-pressed={ariaBool(active())}
                        aria-label={`${lane.name}, step ${step + 1}${
                          active() ? ", on" : ", off"
                        }`}
                        onPointerDown={(event) => pointer.down(event, lane, step)}
                        onClick={(event) => {
                          // Enter and Space on a focused step arrive as a click
                          // with no pointer press (detail 0). A mouse or touch
                          // click already toggled on its press, so it is skipped.
                          if (event.detail === 0) pointer.key(lane, step, event);
                        }}
                      />
                    );
                  }}
                </For>
              </fieldset>
            )}
          </For>
          <Show when={pointer.lasso()}>
            {(rect) => (
              <div
                class="step-lasso"
                style={{
                  left: `${rect().left}px`,
                  top: `${rect().top}px`,
                  width: `${rect().right - rect().left}px`,
                  height: `${rect().bottom - rect().top}px`,
                }}
              />
            )}
          </Show>
        </div>
        {/* Pinned under the last lane, where the next pad would go, as the
            arrangement pins its [+ Sampler] row under the last track. It is
            not a lane, so it sits over the empty ground rather than in the
            lane list, and the ground around it still starts a lasso. */}
        <Show when={addPad()}>
          {(onAddPad) => (
            <div class="step-add-pad">
              <button
                type="button"
                class="new-track-button"
                aria-label="Add pad from library"
                title={
                  kitFull()
                    ? `A drum machine holds at most ${MAX_DRUM_PADS} pads`
                    : "Add a pad with a sound from the library"
                }
                disabled={kitFull()}
                onClick={() => onAddPad()()}
              >
                <HiSolidPlus size={13} />
                <span>Pad</span>
              </button>
            </div>
          )}
        </Show>
        <VelocityLane
          clipId={props.clip.id}
          notes={velocityNotes()}
          selected={selectedSet()}
          steps={stepCount(props.clip)}
          zoom={zoom()}
          beginGesture={(options) => props.beginGesture(options)}
          onEdited={(count) => {
            analytics().logFeatureFirstUse("velocity_lane");
            analytics().log("clip_edited", {
              editor: "step",
              event_count_bucket: eventCountBucket(count),
            });
          }}
          audition={() => {
            const current = row();
            if (current) audition(current);
          }}
          viewport={() => {}}
        />
      </div>
    </section>
  );
}

/**
 * Removes the given notes as one committed command, and clears them from a
 * selection. Exposed for the editor's `edit.delete` shortcut wiring.
 */
export function deleteSelectedNotes(
  clip: Clip,
  ids: readonly EventId[],
  dispatch: (commands: RawCommandInput | readonly RawCommandInput[]) => unknown,
): void {
  if (ids.length === 0) return;
  const present = new Set(
    clip.content.kind === "notes" ? clip.content.events.map((event) => event.id) : [],
  );
  const removable = ids.filter((id) => present.has(id));
  if (removable.length === 0) return;
  dispatch(removeNotes(clip.id, removable));
}
