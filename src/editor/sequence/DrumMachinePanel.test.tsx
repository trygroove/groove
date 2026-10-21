import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import {
  CommandHistory,
  MAX_DRUM_PADS,
  type RawCommandInput,
  type TransactionResult,
} from "../../commands";
import type { DrumPad, NoteTrigger, Track } from "../../domain/entities";
import { dbToFaderPosition, faderPositionToDb } from "../../domain/faders";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import type { PadId, TrackId } from "../../domain/ids";
import { TRACK_VOLUME } from "../../domain/parameters";
import { fillExtent, moveTo, testAnalytics } from "../../instrument/panelTesting";
import type { WatchPeaks } from "../../instrument/SampleWell";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import DrumMachinePanel, { nextPadName } from "./DrumMachinePanel";

afterEach(() => cleanup());

function drumTrackOf(project: ReturnType<typeof createDrumMachineFixtureProject>): Track {
  const track = project.song.tracks.find(
    (candidate) => candidate.instrument?.kind === "drumMachine",
  );
  if (!track) throw new Error("expected a drum-machine track in the fixture");
  return track;
}

function renderPanel(watchPeaks?: WatchPeaks, onBrowseSample?: (padId: PadId) => void) {
  const project = createDrumMachineFixtureProject();
  const track = drumTrackOf(project);
  const assets = project.song.assets.filter((asset) => asset.kind === "sample");
  const dispatch =
    vi.fn<
      (
        commands: RawCommandInput | readonly RawCommandInput[],
      ) => TransactionResult | undefined
    >();
  const audition = vi.fn<(padId: PadId) => void>();
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  render(() => (
    <DrumMachinePanel
      track={track}
      assets={assets}
      dispatch={dispatch}
      // No history behind this render: a control gesture that cannot open one
      // falls back to plain `dispatch`, which is what these assertions read.
      beginGesture={() => undefined}
      audition={audition}
      watchPeaks={watchPeaks}
      onBrowseSample={onBrowseSample}
      analytics={analytics}
    />
  ));
  return { project, track, assets, dispatch, audition, transport };
}

/**
 * The panel over a real command history, so a pad control's rendered value
 * comes back out of the project it edits — which is what a drag has to move,
 * and what one undo press has to put back.
 */
function renderLivePanel() {
  const history = new CommandHistory(createDrumMachineFixtureProject());
  const [project, setProject] = createSignal(history.project);
  history.subscribe(() => setProject(history.project));
  const track = () => drumTrackOf(project());
  const pad = (): DrumPad => {
    const instrument = track().instrument;
    if (instrument?.kind !== "drumMachine") throw new Error("expected a drum machine");
    return instrument.pads[0];
  };
  render(() => (
    <DrumMachinePanel
      track={track()}
      assets={project().song.assets.filter((asset) => asset.kind === "sample")}
      dispatch={(commands) => history.execute(commands)}
      beginGesture={(options) => history.beginGesture(options)}
      analytics={testAnalytics().analytics}
    />
  ));
  return { history, project, pad };
}

/**
 * Every range input the panel renders, in DOM order — pitch, level, pan per
 * pad. Selected structurally rather than by accessible name so the same helper
 * reads the raw inputs of the broken panel and the fill sliders of the fixed
 * one, and a red run can only mean the control itself is wrong.
 */
function rangeInputs(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('.drum-machine input[type="range"]'),
  );
}

describe("DrumMachinePanel", () => {
  it("renders one named lane per pad with mute and solo controls", () => {
    const { track } = renderPanel();
    const padNames =
      track.instrument?.kind === "drumMachine"
        ? track.instrument.pads.map((pad) => pad.name)
        : [];
    for (const name of padNames) {
      expect(
        screen.getByRole("button", { name: `Audition ${name}` }),
      ).toBeInTheDocument();
    }
    // Each pad exposes a Mute and a Solo toggle, named for its pad.
    for (const name of padNames) {
      expect(screen.getByRole("button", { name: `Mute ${name}` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Solo ${name}` })).toBeInTheDocument();
    }
  });

  it("opens the library on the selected pad's sample slot (#447)", () => {
    const onBrowseSample = vi.fn<(padId: PadId) => void>();
    const { track, assets, dispatch } = renderPanel(undefined, onBrowseSample);
    const [first, second] =
      track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
    const slot = screen.getByRole("button", { name: `Sample for ${first.name}` });
    // The slot names the pad's sound, as the row does.
    const name = assets.find((asset) => asset.id === first.assetId)?.name ?? "None";
    expect(slot.textContent).toBe(name);

    fireEvent.click(slot);
    expect(onBrowseSample).toHaveBeenCalledExactlyOnceWith(first.id);
    // Choosing happens in the library; the panel itself dispatches nothing.
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();

    clickAndFlush(screen.getByRole("button", { name: `Audition ${second.name}` }));
    fireEvent.click(screen.getByRole("button", { name: `Sample for ${second.name}` }));
    expect(onBrowseSample).toHaveBeenLastCalledWith(second.id);
  });

  it("logs drum_machine feature_first_use exactly once across several interactions", () => {
    const { transport } = renderPanel();

    fireEvent.click(screen.getAllByRole("button", { name: /^Mute / })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /^Solo / })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /^Audition / })[0]);

    const featureEvents = transport.events.filter(
      (event) => event.name === "feature_first_use",
    );
    expect(featureEvents).toHaveLength(1);
    expect(featureEvents[0]?.params.feature).toBe("drum_machine");
  });

  it("toggles pad mute through a drum.setPadFlag command", () => {
    const { dispatch } = renderPanel();
    fireEvent.click(screen.getAllByRole("button", { name: /^Mute / })[0]);

    const command = dispatch.mock.calls[0][0] as {
      type: string;
      payload: { flag: string; value: boolean };
    };
    expect(command.type).toBe("drum.setPadFlag");
    expect(command.payload.flag).toBe("muted");
    expect(command.payload.value).toBe(true);
  });

  // #255: the pad controls were raw `<input type="range">` — native track,
  // native thumb, no fill, no readout — beside the mixer's thumbless fill
  // sliders, and each pointer move dispatched a whole command of its own.
  it("paints every pad control as a thumbless fill slider (#255)", () => {
    renderPanel();
    const sliders = rangeInputs();
    expect(sliders.length).toBeGreaterThan(0);
    for (const slider of sliders) {
      // The fill track is what carries the value; a bare input has a thumb.
      expect(slider.closest(".fill-slider-track")).not.toBeNull();
      // The filled portion *is* the value, so it has a measurable extent…
      expect(fillExtent(slider)).not.toBe("");
      // …and the live value is written out beside it, in its value field.
      const readout = slider
        .closest(".fill-slider")
        ?.querySelector<HTMLInputElement>(".fill-slider-entry");
      expect(readout?.value ?? "").not.toBe("");
    }
  });

  it("runs one pad-level drag as one history entry and one revision (#255)", () => {
    const { history, project, pad } = renderLivePanel();
    const startRevision = project().metadata.revision;
    const restingLevel = pad().mixer.volume;
    // Pitch, level, pan — the first pad's level is the second control.
    const level = rangeInputs()[1];

    // Mid-drag: `input` has fired, `change` has not. The value still has to
    // follow the pointer, on screen and in the project the audio graph reads.
    // The level travels in fader positions, and stores decibels (#634).
    moveTo(level, "0.6");
    expect(pad().mixer.volume).toBeCloseTo(faderPositionToDb(TRACK_VOLUME, 0.6));
    moveTo(level, "0.5");
    expect(pad().mixer.volume).toBeCloseTo(faderPositionToDb(TRACK_VOLUME, 0.5));
    // Nothing is committed until the drag ends.
    expect(history.entries).toHaveLength(0);

    fireAndFlush(() => {
      fireEvent.change(level, { target: { value: "0.5" } });
    });
    expect(history.entries).toHaveLength(1);
    expect(project().metadata.revision).toBe(startRevision + 1);

    // …so a single undo puts the whole drag back.
    fireAndFlush(() => {
      history.undo();
    });
    expect(pad().mixer.volume).toBeCloseTo(restingLevel);
  });

  it("auditions a pad when its name button is clicked", () => {
    const { track, audition } = renderPanel();
    const firstPadName =
      track.instrument?.kind === "drumMachine" ? track.instrument.pads[0].name : "";
    fireEvent.click(screen.getByRole("button", { name: `Audition ${firstPadName}` }));
    expect(audition).toHaveBeenCalledTimes(1);
  });
});

describe("DrumMachinePanel table (#447)", () => {
  it("heads the pads with their column names, hidden from assistive tech", () => {
    renderPanel();
    const head = document.querySelector(".drum-pad-head");
    expect(head).toHaveAttribute("aria-hidden", "true");
    expect(head?.textContent).toBe("#PadSamplePreviewPitchLevelPanChokeM · S");
    expect(document.querySelector(".pad-index")?.textContent).toBe("01");
  });

  it("previews each pad's own waveform, and plays the pad from it", () => {
    const watch = vi.fn<WatchPeaks>((_id, _buckets, onPeaks) => {
      onPeaks(Float32Array.from([1, 0.5, 0.25]));
      return () => {};
    });
    const { track, audition } = renderPanel(watch);
    flush();
    const pad =
      track.instrument?.kind === "drumMachine" ? track.instrument.pads[0] : undefined;
    expect(watch).toHaveBeenCalledWith(
      pad?.assetId,
      expect.any(Number),
      expect.any(Function),
    );

    const preview = screen.getByRole("button", { name: `Preview ${pad?.name}` });
    expect(preview.querySelector("path")?.getAttribute("d")).toMatch(/^M/);
    fireEvent.click(preview);
    expect(audition).toHaveBeenCalledExactlyOnceWith(pad?.id);
  });
});

/**
 * The last value a pad-level control dispatched through `drum.setPadParameter`.
 * With no history behind the render, each step lands as one plain dispatch.
 */
function lastPadLevel(dispatch: ReturnType<typeof renderPanel>["dispatch"]): number {
  const command = dispatch.mock.calls.at(-1)?.[0] as RawCommandInput;
  expect(command.type).toBe("drum.setPadParameter");
  const payload = command.payload as { parameterId: string; value: number };
  expect(payload.parameterId).toBe(TRACK_VOLUME.id);
  return payload.value;
}

describe("DrumMachinePanel pad level fader law (#634)", () => {
  it("moves the row's and the editor's pad level on the mixer faders' curve", () => {
    const { track, dispatch } = renderPanel();
    const instrument = track.instrument;
    if (instrument?.kind !== "drumMachine") throw new Error("expected a drum machine");
    const [first] = instrument.pads;
    const editor = screen.getByRole("region", { name: `${first.name} pad` });
    const levels = [
      screen.getByRole("slider", { name: `Level for ${first.name}` }),
      within(editor).getByRole("slider", { name: "Level" }),
    ] as HTMLInputElement[];
    for (const level of levels) {
      // The pad's level sits where a mixer fader shows the same decibels.
      expect(Number(level.value)).toBeCloseTo(
        dbToFaderPosition(TRACK_VOLUME, first.mixer.volume),
        2,
      );
      // The same travel stores the same decibels a mixer fader would.
      moveTo(level, "0.5");
      expect(lastPadLevel(dispatch)).toBeCloseTo(faderPositionToDb(TRACK_VOLUME, 0.5));
      // Double-click still puts the pad back to 0 dB (#536).
      fireAndFlush(() => {
        fireEvent.dblClick(level);
      });
      expect(lastPadLevel(dispatch)).toBeCloseTo(TRACK_VOLUME.defaultValue);
      // The value field still takes decibels, not fader positions.
      const field = level
        .closest(".fill-slider")
        ?.querySelector<HTMLInputElement>(".fill-slider-entry") as HTMLInputElement;
      fireAndFlush(() => {
        fireEvent.change(field, { target: { value: "-6" } });
      });
      expect(lastPadLevel(dispatch)).toBeCloseTo(-6, 1);
    }
  });
});

describe("DrumMachinePanel selected pad (#447)", () => {
  const pads = (track: ReturnType<typeof renderPanel>["track"]) =>
    track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];

  it("shows the first pad in one editor above the table, and another when its name is pressed", () => {
    const { track } = renderPanel();
    const [first, second] = pads(track);
    const editor = screen.getByRole("region", { name: `${first.name} pad` });
    expect(
      screen.getByRole("heading", { name: `${first.name} · sound` }),
    ).toBeInTheDocument();
    expect(within(editor).getByLabelText("Attack")).toBeInTheDocument();
    // One editor, and it comes before every row of the table.
    expect(screen.getAllByRole("region", { name: / pad$/ })).toEqual([editor]);
    const firstRow = document.querySelector(".drum-pad:not(.drum-pad-head)");
    expect(
      editor.compareDocumentPosition(firstRow as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `Audition ${second.name}` }));
    flush();
    expect(screen.queryByRole("heading", { name: `${first.name} · sound` })).toBeNull();
    const secondEditor = screen.getByRole("region", { name: `${second.name} pad` });
    expect(within(secondEditor).getByLabelText("Decay")).toBeInTheDocument();
    expect(document.querySelector(".drum-pad.selected")?.textContent).toContain(
      second.name,
    );
  });

  it("names the editor's faders apart from the row's, so none is on screen twice", () => {
    const { track } = renderPanel();
    const [first] = pads(track);
    const editor = screen.getByRole("region", { name: `${first.name} pad` });
    for (const name of ["Pitch", "Level", "Pan"]) {
      // The editor's own, which its region names for the pad...
      expect(within(editor).getByRole("slider", { name })).toBeInTheDocument();
      // ...and the row's, which says whose pad: one of each, never two alike.
      expect(
        screen.getAllByRole("slider", { name: `${name} for ${first.name}` }),
      ).toHaveLength(1);
    }
  });

  it("selects a pad when anywhere on its row is pressed, without auditioning it", () => {
    const { track, audition } = renderPanel();
    const [, second] = pads(track);
    const rows = document.querySelectorAll(".drum-pad:not(.drum-pad-head)");
    clickAndFlush(rows[1].querySelector(".pad-index") as HTMLElement);
    expect(
      screen.getByRole("region", { name: `${second.name} pad` }),
    ).toBeInTheDocument();
    expect(rows[1]).toHaveClass("selected");
    expect(
      screen.getByRole("button", { name: `Audition ${second.name}` }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(audition).not.toHaveBeenCalled();
  });
});

describe("DrumMachinePanel adding a pad (#447)", () => {
  it("adds an empty pad at the end and selects it, as one undoable entry", () => {
    const { history, pad } = renderLivePanel();
    const drumPads = () => {
      const track = history.project.song.tracks.find(
        (candidate) => candidate.instrument?.kind === "drumMachine",
      );
      return track?.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
    };
    const before = drumPads().length;

    clickAndFlush(screen.getByRole("button", { name: /^Add pad to / }));

    expect(drumPads()).toHaveLength(before + 1);
    const added = drumPads()[before];
    expect(added.name).toBe(`Pad ${before + 1}`);
    expect(added.assetId).toBeNull();
    expect(history.entries).toHaveLength(1);
    // The new pad shows in the editor, ready for its sample.
    expect(
      screen.getByRole("heading", { name: `${added.name} · sound` }),
    ).toBeInTheDocument();

    fireAndFlush(() => {
      history.undo();
    });
    expect(drumPads()).toHaveLength(before);
    expect(pad().name).toBe(drumPads()[0].name);
  });

  it("names a new pad after the first free number", () => {
    const { track } = fixtureDrumTrack();
    const existing =
      track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
    expect(nextPadName([])).toBe("Pad 1");
    expect(nextPadName([{ ...existing[0], name: "Pad 2" }])).toBe("Pad 3");
  });

  it("stops at the drum machine's pad limit", () => {
    const { track } = fixtureDrumTrack();
    const [first] = track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
    const full: Track = {
      ...track,
      instrument: {
        kind: "drumMachine",
        parameters: {},
        pads: Array.from({ length: MAX_DRUM_PADS }, (_, index) => ({
          ...first,
          id: `pad_${index}` as PadId,
          name: `P${index}`,
        })),
      },
    };
    render(() => (
      <DrumMachinePanel
        track={full}
        assets={[]}
        dispatch={() => undefined}
        beginGesture={() => undefined}
        analytics={testAnalytics().analytics}
      />
    ));
    expect(
      screen.getByRole("button", { name: `Add pad to ${full.name}` }),
    ).toBeDisabled();
    expect(
      screen.getByText(`A drum machine holds at most ${MAX_DRUM_PADS} pads.`),
    ).toBeInTheDocument();
  });
});

/** The fixture's drum-machine track, on its own. */
function fixtureDrumTrack() {
  return { track: drumTrackOf(createDrumMachineFixtureProject()) };
}

describe("DrumMachinePanel playing pads (#447)", () => {
  it("lights a pad's name when it fires, and unsubscribes when it goes", () => {
    vi.useFakeTimers();
    try {
      const project = createDrumMachineFixtureProject();
      const track = drumTrackOf(project);
      const [, second] =
        track.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
      let fire: (trigger: NoteTrigger) => void = () => {};
      const unsubscribe = vi.fn();
      const { unmount } = render(() => (
        <DrumMachinePanel
          track={track}
          assets={project.song.assets}
          dispatch={() => undefined}
          beginGesture={() => undefined}
          watchTriggers={(_trackId, onTrigger) => {
            fire = onTrigger;
            return unsubscribe;
          }}
        />
      ));
      flush();
      const row = () =>
        screen
          .getByRole("button", { name: `Audition ${second.name}` })
          .closest(".drum-pad");

      fireAndFlush(() => fire({ kind: "pad", padId: second.id }));
      expect(row()?.classList.contains("hit")).toBe(true);
      // A pitched trigger is not a pad; nothing else lights.
      fireAndFlush(() => fire({ kind: "pitch", pitch: 60 }));
      expect(document.querySelectorAll(".drum-pad.hit")).toHaveLength(1);

      fireAndFlush(() => vi.advanceTimersByTime(150));
      expect(row()?.classList.contains("hit")).toBe(false);

      unmount();
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows the track it shows, when the panel moves to another drum track", () => {
    const project = createDrumMachineFixtureProject();
    const first = drumTrackOf(project);
    const second = { ...first, id: "trk_other" as TrackId };
    const [track, setTrack] = createSignal(first);
    const watched: string[] = [];
    const stopped: string[] = [];
    render(() => (
      <DrumMachinePanel
        track={track()}
        assets={project.song.assets}
        dispatch={() => undefined}
        beginGesture={() => undefined}
        watchTriggers={(trackId) => {
          watched.push(trackId);
          return () => stopped.push(trackId);
        }}
      />
    ));
    flush();
    expect(watched).toEqual([first.id]);

    setTrack(second);
    flush();
    expect(stopped).toEqual([first.id]);
    expect(watched).toEqual([first.id, second.id]);

    // An edit to the same track is not a new subscription.
    setTrack({ ...second, name: "Renamed" });
    flush();
    expect(watched).toHaveLength(2);
  });
});

describe("DrumMachinePanel pad rename (#666)", () => {
  function firstPad(track: Track): DrumPad {
    if (track.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    return track.instrument.pads[0];
  }

  function renderWithHistory() {
    const { track, audition, transport, dispatch } = renderPanel();
    dispatch.mockReturnValue({ ok: true } as TransactionResult);
    return { pad: firstPad(track), track, audition, transport, dispatch };
  }

  async function openEditor(name: string): Promise<HTMLInputElement> {
    clickAndFlush(screen.getByRole("button", { name: `Rename ${name}` }));
    await Promise.resolve();
    return screen.getByRole("textbox", { name: `Name of ${name}` }) as HTMLInputElement;
  }

  it("swaps the name for a text input on click and commits Enter as drum.renamePad", async () => {
    const { pad, track, dispatch, audition } = renderWithHistory();
    const input = await openEditor(pad.name);
    expect(input).toHaveFocus();
    input.value = "  Hi-hat ";
    fireAndFlush(() => fireEvent.change(input));
    expect(dispatch).toHaveBeenCalledWith({
      type: "drum.renamePad",
      payload: { trackId: track.id, padId: pad.id, name: "Hi-hat" },
    });
    expect(screen.queryByRole("textbox", { name: /^Name of / })).toBeNull();
    // Renaming never auditions.
    expect(audition).not.toHaveBeenCalled();
  });

  it("commits nothing for an empty or unchanged name, and on Escape", async () => {
    const { pad, dispatch } = renderWithHistory();
    for (const value of ["   ", pad.name]) {
      const input = await openEditor(pad.name);
      input.value = value;
      fireAndFlush(() => fireEvent.change(input));
      expect(screen.queryByRole("textbox", { name: /^Name of / })).toBeNull();
    }
    const input = await openEditor(pad.name);
    input.value = "Nope";
    fireAndFlush(() => fireEvent.keyDown(input, { key: "Escape" }));
    expect(screen.queryByRole("textbox", { name: /^Name of / })).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("commits a changed name when focus leaves the input", async () => {
    const { pad, dispatch } = renderWithHistory();
    const input = await openEditor(pad.name);
    input.value = "Ride";
    fireAndFlush(() => {
      fireEvent.change(input);
      fireEvent.blur(input);
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("auditions from its own play button without renaming or selecting twice", () => {
    const { pad, audition, dispatch } = renderWithHistory();
    fireEvent.click(screen.getByRole("button", { name: `Audition ${pad.name}` }));
    expect(audition).toHaveBeenCalledExactlyOnceWith(pad.id);
    expect(screen.queryByRole("textbox", { name: /^Name of / })).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("logs drum_pad_rename feature_first_use once, never carrying the name", async () => {
    const { pad, transport } = renderWithHistory();
    for (const name of ["Ride", "Crash"]) {
      const input = await openEditor(pad.name);
      input.value = name;
      fireAndFlush(() => fireEvent.change(input));
    }
    const events = transport.events.filter(
      (event) =>
        event.name === "feature_first_use" && event.params.feature === "drum_pad_rename",
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(transport.events)).not.toMatch(/Ride|Crash/);
  });

  it("changes nothing but the event when analytics is disabled", async () => {
    const project = createDrumMachineFixtureProject();
    const track = drumTrackOf(project);
    const pad = firstPad(track);
    const transport = createRecordingTransport();
    const consent = new ConsentStore(memoryStorage());
    consent.optOut();
    const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
    analytics.setAccountType("anonymous");
    const dispatch = vi.fn().mockReturnValue({ ok: true });
    render(() => (
      <DrumMachinePanel
        track={track}
        assets={[]}
        dispatch={dispatch}
        beginGesture={() => undefined}
        analytics={analytics}
      />
    ));
    const input = await openEditor(pad.name);
    input.value = "Ride";
    fireAndFlush(() => fireEvent.change(input));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(transport.events.filter((e) => e.name === "feature_first_use")).toHaveLength(
      0,
    );
  });
});
