import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import type { Instrument } from "../../domain/entities";
import {
  hasLibrarySampleDrag,
  type LibrarySample,
  readLibrarySampleDrag,
} from "../../library/assetDrag";
import "../../instrument/InstrumentPanel.css";

export interface InstrumentAreaProps {
  /** Names the region, and so names a drop's target (#225). */
  readonly trackName: string;
  readonly instrument: Instrument | null;
  /** Loads a sound dropped from the library onto this track's sampler. */
  loadSample(sample: LibrarySample): void;
  readonly children: JSX.Element;
}

/**
 * One track's instrument controls — the kind picker (#224) and whichever panel
 * that kind gets — inside a single region named for the track.
 *
 * It exists to be a *drop target* (#225). Dragging a sound onto an instrument is
 * how a producer expects to load one, and the target has to be identifiable: a
 * project with several tracks has several of these, so the region is named
 * `"Hats instrument"` rather than `"Sampler"`, and a drop lands on a particular
 * track. The panels inside keep their own names (`"Sampler"`, `"Synth voice"`),
 * which is what lets the picker's own region stay simply `"Instrument"`.
 *
 * The whole area is the target rather than the sampler panel alone, for two
 * reasons: the gesture does not require hitting a small strip, and a `drop` does
 * not travel *down* the tree — landing on the picker at the top of the area
 * would otherwise reach no handler at all.
 *
 * Only a sampler takes a sound. A drag over a synth or drum-machine track is
 * left to the browser, so it shows no drop cursor and nothing is dispatched.
 */
export default function InstrumentArea(props: InstrumentAreaProps): JSX.Element {
  const [dragOver, setDragOver] = createSignal(false);
  const takesSample = () => props.instrument?.kind === "sampler";

  /**
   * Claims a drag this track can take. Cancelling the event is what marks the
   * element a drop target, so a drag it cannot take is left entirely alone —
   * no drop cursor, and the browser's own handling of it is undisturbed.
   */
  function claim(event: DragEvent): void {
    if (!takesSample() || !hasLibrarySampleDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  return (
    <section
      class={["instrument-area", { "instrument-panel-drop-target": dragOver() }]}
      aria-label={`${props.trackName} instrument`}
      // A drop target is claimed on arrival *and* on every move over it. Both
      // matter: the drag-and-drop processing model picks the element a drag is
      // pointing at from `dragenter`, and when that event goes uncancelled it
      // hands the drag to the body element instead — after which this area's
      // `dragover` is never fired at all, so nothing lights up and nothing can
      // be dropped anywhere. Chromium is lenient and keeps firing `dragover`
      // at the element under the pointer regardless, which is why cancelling
      // only `dragover` looks correct there and fails everywhere else.
      onDragEnter={(event) => claim(event)}
      onDragOver={(event) => claim(event)}
      onDragLeave={(event) => {
        // `dragleave` bubbles, so every step from one panel inside the area
        // to the next reports a leave the drag never made. Taking the
        // affordance down on those blinks the outline off exactly while the
        // user is steering towards the target. Only a move to somewhere
        // outside the area — or off the window, which reports no related
        // target at all — is a real departure.
        const entering = event.relatedTarget;
        if (entering instanceof Node && event.currentTarget.contains(entering)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        setDragOver(false);
        if (!takesSample()) return;
        const sample = readLibrarySampleDrag(event.dataTransfer);
        if (!sample) return;
        event.preventDefault();
        props.loadSample(sample);
      }}
    >
      {props.children}
    </section>
  );
}
