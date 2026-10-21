import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instrument } from "../../domain/entities";
import { packVersion } from "../../domain/entities";
import type { AssetId, PackId } from "../../domain/ids";
import { LIBRARY_SAMPLE_MIME, type LibrarySample } from "../../library/assetDrag";
import InstrumentArea from "./InstrumentArea";

afterEach(() => cleanup());

const SAMPLER: Instrument = {
  kind: "sampler",
  assetId: "ast_a" as AssetId,
  parameters: {},
};
const SYNTH: Instrument = { kind: "synth", parameters: {} };

const DROPPED: LibrarySample = {
  name: "Closed Hat",
  packId: "pak_SdlN_OazweXrwury0j27Y" as PackId,
  packVersion: packVersion("1.0.0"),
  kind: "sample",
  storageRef: "samples/starter-library/audio/sha256/ab/cd/abcd.wav",
  url: "/samples/starter-library/audio/sha256/ab/cd/abcd.wav",
  durationSeconds: 0.25,
  sampleRate: 48000,
  channelCount: 1,
  licence: "solid-groove-owned",
  bpm: null,
  bars: null,
};

/**
 * jsdom implements no `DataTransfer`, so a drag test supplies the slice the
 * area reads: the type list a `dragover` may see, and the data a `drop` gets.
 */
function transferCarrying(payload: string | null) {
  return {
    types: payload === null ? ["text/plain"] : [LIBRARY_SAMPLE_MIME],
    dropEffect: "none",
    getData: (format: string) =>
      format === LIBRARY_SAMPLE_MIME && payload !== null ? payload : "",
    setData: () => {},
  };
}

function renderArea(instrument: Instrument | null = SAMPLER) {
  const loadSample = vi.fn();
  render(() => (
    <InstrumentArea trackName="Hats" instrument={instrument} loadSample={loadSample}>
      <p>panel goes here</p>
      <p>and another panel</p>
    </InstrumentArea>
  ));
  return { loadSample };
}

/**
 * A `dragleave` that says where the pointer went next.
 *
 * jsdom implements no `DragEvent`, so `fireEvent.dragLeave` quietly drops
 * `relatedTarget` — the one field that distinguishes stepping between the
 * panels inside the area from leaving it. A `MouseEvent` of the same name
 * carries it, and in a browser `DragEvent` inherits the field from `MouseEvent`
 * anyway, so this dispatches exactly what the handler reads.
 */
function leaveTowards(from: HTMLElement, to: EventTarget | null): void {
  fireEvent(
    from,
    new MouseEvent("dragleave", {
      bubbles: true,
      cancelable: true,
      relatedTarget: to,
    }),
  );
  flush();
}

/** The area, found the way a drag target is: by its accessible name. */
function area(): HTMLElement {
  return screen.getByRole("region", { name: "Hats instrument" });
}

const isTarget = () => area().classList.contains("instrument-panel-drop-target");

describe("InstrumentArea", () => {
  it("is named for its track, so a drop lands on a particular one", () => {
    renderArea();
    expect(area()).toBeInTheDocument();
    expect(screen.getByText("panel goes here")).toBeInTheDocument();
  });

  it("loads a dropped library sound", () => {
    const { loadSample } = renderArea();
    fireEvent.drop(area(), {
      dataTransfer: transferCarrying(JSON.stringify(DROPPED)),
    });
    expect(loadSample).toHaveBeenCalledTimes(1);
    expect(loadSample.mock.calls[0][0]).toEqual(DROPPED);
  });

  it("ignores a drop carrying anything else", () => {
    const { loadSample } = renderArea();
    fireEvent.drop(area(), { dataTransfer: transferCarrying(null) });
    expect(loadSample).not.toHaveBeenCalled();
  });

  it("ignores a drop whose payload is not a library sound", () => {
    const { loadSample } = renderArea();
    fireEvent.drop(area(), {
      dataTransfer: transferCarrying('{"name":"Evil"}'),
    });
    expect(loadSample).not.toHaveBeenCalled();
  });

  it("becomes a drop target the moment the drag arrives", () => {
    renderArea();
    const transfer = transferCarrying(JSON.stringify(DROPPED));
    // A browser decides what a drag may be dropped on from `dragenter` as
    // well as `dragover` (the HTML drag-and-drop processing model): an
    // uncancelled `dragenter` sends the pointer's target back to the body,
    // and this element's `dragover` is then never consulted at all. Chromium
    // is lenient about that first step and accepts the drop anyway; a browser
    // that follows the model shows no affordance and takes no drop. So the
    // arrival has to be claimed too. `fireEvent` returns false when a handler
    // cancelled the event, which is what claiming it means.
    const allowed = fireEvent.dragEnter(area(), {
      dataTransfer: transfer,
      cancelable: true,
    });
    flush();
    expect(allowed).toBe(false);
    expect(transfer.dropEffect).toBe("copy");
    expect(isTarget()).toBe(true);
  });

  it("leaves an arriving drag it cannot take alone", () => {
    renderArea(SYNTH);
    const transfer = transferCarrying(JSON.stringify(DROPPED));
    const allowed = fireEvent.dragEnter(area(), {
      dataTransfer: transfer,
      cancelable: true,
    });
    flush();
    expect(allowed).toBe(true);
    expect(isTarget()).toBe(false);
  });

  it("marks itself a copy target only while a sound is over it", () => {
    renderArea();
    const transfer = transferCarrying(JSON.stringify(DROPPED));
    fireEvent.dragOver(area(), { dataTransfer: transfer });
    flush();
    expect(transfer.dropEffect).toBe("copy");
    expect(isTarget()).toBe(true);

    fireEvent.dragLeave(area(), { dataTransfer: transfer });
    flush();
    expect(isTarget()).toBe(false);
  });

  it("keeps the affordance while the drag crosses its own contents", () => {
    renderArea();
    const transfer = transferCarrying(JSON.stringify(DROPPED));
    fireEvent.dragOver(area(), { dataTransfer: transfer });
    flush();
    expect(isTarget()).toBe(true);

    // Moving from one panel to the next fires `dragleave` on the panel the
    // pointer left, and that bubbles to the area — but the drag is still
    // inside it, so the drop affordance must stay up. Anything else flickers
    // the outline off exactly while the user is aiming at the target.
    leaveTowards(
      screen.getByText("panel goes here"),
      screen.getByText("and another panel"),
    );
    expect(isTarget()).toBe(true);
  });

  it("drops the affordance once the drag really leaves", () => {
    renderArea();
    const transfer = transferCarrying(JSON.stringify(DROPPED));
    fireEvent.dragOver(area(), { dataTransfer: transfer });
    flush();
    leaveTowards(screen.getByText("panel goes here"), document.body);
    expect(isTarget()).toBe(false);
  });

  it("leaves a drag it cannot take to the browser", () => {
    renderArea();
    const transfer = transferCarrying(null);
    fireEvent.dragOver(area(), { dataTransfer: transfer });
    flush();
    expect(transfer.dropEffect).toBe("none");
    expect(isTarget()).toBe(false);
  });

  it("takes nothing when the track has no sampler to load into", () => {
    const { loadSample } = renderArea(SYNTH);
    const transfer = transferCarrying(JSON.stringify(DROPPED));

    // Not even a drop cursor: a synth track is not a target at all.
    fireEvent.dragOver(area(), { dataTransfer: transfer });
    flush();
    expect(transfer.dropEffect).toBe("none");
    expect(isTarget()).toBe(false);

    fireEvent.drop(area(), { dataTransfer: transfer });
    expect(loadSample).not.toHaveBeenCalled();
  });
});
