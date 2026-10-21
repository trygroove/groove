import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import {
  CommandHistory,
  type Gesture,
  type GestureOptions,
  type RawCommandInput,
} from "../../commands";
import { createDevice } from "../../domain/devices";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createReferenceProject,
  createSliceFixtureProject,
} from "../../domain/fixtures";
import type { TrackId } from "../../domain/ids";
import { createSeededIdFactory } from "../../domain/ids";
import { TICKS_PER_BAR } from "../../domain/time";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import { dragTrackHandle, stubTrackDragLayout } from "../../testing/trackDrag";
import type { TrackLevel } from "../tracks/trackLevels";
import { chainSummary } from "./MasterStrip";
import Mixer from "./Mixer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A harness that drives the mixer against a real {@link CommandHistory}, so a
 * dispatched command actually mutates the project the mixer re-renders from and
 * a gesture actually collapses into one history entry — the two behaviors the
 * acceptance criteria turn on.
 */
function renderMixer(
  initial: Project = createSliceFixtureProject(),
  masterLevel?: () => TrackLevel | null,
) {
  const history = new CommandHistory(initial);
  const [project, setProject] = createSignal(history.project);

  const dispatch = (commands: RawCommandInput | readonly RawCommandInput[]) => {
    const result = history.execute(commands);
    setProject(history.project);
    return result;
  };

  const beginGesture = (options?: GestureOptions): Gesture => {
    const gesture = history.beginGesture(options);
    return {
      get active() {
        return gesture.active;
      },
      apply(commands) {
        const result = gesture.apply(commands);
        setProject(history.project);
        return result;
      },
      commit(summary) {
        const entry = gesture.commit(summary);
        setProject(history.project);
        return entry;
      },
      cancel() {
        gesture.cancel();
        setProject(history.project);
      },
    };
  };

  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");

  // Track selection is the host's state (`EditorView` holds it in the shared
  // selection model); the harness plays that host, recording what the mixer
  // asks for and feeding the answer back in.
  const selected: TrackId[] = [];
  const [selectedTrackId, setSelectedTrackId] = createSignal<TrackId | null>(null);

  render(() => (
    <Mixer
      project={project()}
      dispatch={dispatch}
      beginGesture={beginGesture}
      trackLevel={() => null}
      masterLevel={masterLevel}
      analytics={analytics}
      selectedTrackId={selectedTrackId()}
      onSelectTrack={(trackId) => {
        selected.push(trackId);
        setSelectedTrackId(trackId);
      }}
    />
  ));

  return { history, project, transport, selected };
}

describe("Mixer strip colour (#534)", () => {
  it("opens the palette from the strip's colour edge and recolours as one undo entry", () => {
    const { history, project } = renderMixer();
    const track = project().song.tracks[0];
    if (!track) throw new Error("fixture has no track");

    clickAndFlush(screen.getByRole("button", { name: `Colour for ${track.name}` }));
    const palette = screen.getByRole("group", { name: `Colour for ${track.name}` });
    expect(within(palette).getAllByRole("radio")).toHaveLength(50);
    clickAndFlush(within(palette).getByRole("radio", { name: "Colour 7 of 50" }));

    const recoloured = project().song.tracks.find((t) => t.id === track.id);
    expect(recoloured?.color).not.toBe(track.color);
    history.undo();
    expect(history.project.song.tracks.find((t) => t.id === track.id)?.color).toBe(
      track.color,
    );
    expect(history.canUndo).toBe(false);
  });
});

describe("Mixer track management (TRK-01)", () => {
  it("adds an instrument track and emits track_added + the mixer feature key", () => {
    const { history, transport } = renderMixer();
    const before = history.project.song.tracks.length;

    clickAndFlush(screen.getByRole("button", { name: "Add synth track" }));

    expect(history.project.song.tracks.length).toBe(before + 1);
    const added = transport.events.filter((e) => e.name === "track_added");
    expect(added).toHaveLength(1);
    expect(added[0]?.params.track_type).toBe("instrument");
    const firstUse = transport.events.filter((e) => e.name === "feature_first_use");
    expect(firstUse).toHaveLength(1);
    expect(firstUse[0]?.params.feature).toBe("mixer");
  });

  it("emits the mixer feature key at most once across several adds", () => {
    const { transport } = renderMixer();
    clickAndFlush(screen.getByRole("button", { name: "Add synth track" }));
    clickAndFlush(screen.getByRole("button", { name: "Add sampler track" }));
    expect(transport.events.filter((e) => e.name === "feature_first_use")).toHaveLength(
      1,
    );
    // But a track_added fires for each add.
    expect(transport.events.filter((e) => e.name === "track_added")).toHaveLength(2);
  });

  it("creates a track of the instrument the user asked for (#223)", () => {
    const { history, transport } = renderMixer();

    for (const [button, kind, analyticsType] of [
      ["Add sampler track", "sampler", "sampler"],
      ["Add drum machine track", "drumMachine", "drum_machine"],
      ["Add synth track", "synth", "synth"],
    ] as const) {
      clickAndFlush(screen.getByRole("button", { name: button }));
      const added = history.project.song.tracks.at(-1);
      expect(added?.instrument?.kind, button).toBe(kind);
      expect(
        transport.events.filter((e) => e.name === "track_added").at(-1)?.params
          .instrument_type,
      ).toBe(analyticsType);
    }
  });

  it("gives a new track an empty one-bar clip to program, in one transaction", () => {
    const { history } = renderMixer();
    const revisionBefore = history.project.metadata.revision;

    clickAndFlush(screen.getByRole("button", { name: "Add sampler track" }));

    const track = history.project.song.tracks.at(-1);
    const clip = history.project.clips.find((c) => c.trackId === track?.id);
    expect(clip?.content).toEqual({ kind: "notes", events: [] });
    expect(clip?.lengthTicks).toBe(TICKS_PER_BAR);
    const placement = history.project.song.placements.find((p) => p.clipId === clip?.id);
    expect(placement?.startTicks).toBe(0);
    expect(placement?.durationTicks).toBe(TICKS_PER_BAR);

    // Track, clip and placement arrive together: one revision, one undo.
    expect(history.project.metadata.revision).toBe(revisionBefore + 1);
    history.undo();
    expect(history.project.song.tracks).toHaveLength(1);
    expect(history.project.clips.some((c) => c.id === clip?.id)).toBe(false);
  });

  it("opens a new drum machine with its kit's sounds loaded (#447)", () => {
    const { history } = renderMixer();
    const assetsBefore = history.project.song.assets.length;

    clickAndFlush(screen.getByRole("button", { name: "Add drum machine track" }));

    const instrument = history.project.song.tracks.at(-1)?.instrument;
    const pads = instrument?.kind === "drumMachine" ? instrument.pads : [];
    expect(pads.map((pad) => pad.name)).toEqual(["BD", "SD", "HH", "CP"]);
    const sounds = pads.map(
      (pad) =>
        history.project.song.assets.find((asset) => asset.id === pad.assetId)?.name,
    );
    expect(sounds.every((name) => typeof name === "string")).toBe(true);
    // The kit's sounds join the project in the same single undoable step.
    expect(new Set(pads.map((pad) => pad.assetId)).size).toBe(4);
    expect(history.project.song.assets.length).toBeGreaterThan(assetsBefore);
    expect(history.entries).toHaveLength(1);
  });

  it("names each new track for its instrument, without repeating a name", () => {
    const { history } = renderMixer();

    clickAndFlush(screen.getByRole("button", { name: "Add sampler track" }));
    clickAndFlush(screen.getByRole("button", { name: "Add sampler track" }));

    expect(history.project.song.tracks.map((track) => track.name)).toEqual([
      "BD",
      "Sampler",
      "Sampler 2",
    ]);
  });

  it("reports the duplicated track's own instrument on track_added", () => {
    const { transport } = renderMixer(createDrumMachineFixtureProject());

    clickAndFlush(screen.getAllByRole("button", { name: /^Duplicate / })[0]);

    expect(
      transport.events.filter((e) => e.name === "track_added").at(-1)?.params
        .instrument_type,
    ).toBe("drum_machine");
  });

  it("selects the track it just added, so the editor follows it (#228)", () => {
    const { history, selected } = renderMixer();

    clickAndFlush(screen.getByRole("button", { name: "Add sampler track" }));

    const added = history.project.song.tracks.at(-1);
    expect(selected).toEqual([added?.id]);
  });

  it("renames a track through a command", () => {
    const { history } = renderMixer();
    const input = screen.getByLabelText("Track name") as HTMLInputElement;
    input.value = "Kick drum";
    fireEvent.change(input);
    flush();
    expect(history.project.song.tracks[0].name).toBe("Kick drum");
  });

  // #866: named only by a hidden `<label for>`, as the header tempo box was.
  it("names each track's name field on the element itself (#866)", () => {
    renderMixer();
    expect(screen.getByLabelText("Track name")).toHaveAttribute(
      "aria-label",
      "Track name",
    );
  });

  it("puts the name back on Escape, with no undo entry", () => {
    const { history } = renderMixer();
    const name = history.project.song.tracks[0].name;
    const input = screen.getByLabelText("Track name") as HTMLInputElement;
    fireAndFlush(() => input.focus());
    input.value = "Nope";
    fireAndFlush(() => fireEvent.keyDown(input, { key: "Escape" }));
    expect(input.value).toBe(name);
    expect(history.canUndo).toBe(false);
  });

  it("reorders tracks while preserving clip ownership and routing", () => {
    const { history } = renderMixer(createDrumMachineFixtureProject());
    const [first, second] = history.project.song.tracks;
    const firstClips = history.project.clips
      .filter((c) => c.trackId === first.id)
      .map((c) => c.id);

    clickAndFlush(screen.getByRole("button", { name: `Move ${first.name} right` }));

    const reordered = history.project.song.tracks;
    // The moved track keeps its id, its clips, and its sends.
    const movedNow = reordered.find((t) => t.id === first.id);
    expect(movedNow?.order).toBe(1);
    expect(
      history.project.clips.filter((c) => c.trackId === first.id).map((c) => c.id),
    ).toEqual(firstClips);
    expect(movedNow?.sendConfig).toEqual(first.sendConfig);
    expect(reordered.find((t) => t.id === second.id)?.order).toBe(0);
  });

  it("moves a strip with the arrow keys while its Edit control has focus (#447)", () => {
    const { history, transport } = renderMixer(createDrumMachineFixtureProject());
    const [first, second] = history.project.song.tracks;
    const names = () => history.project.song.tracks.map((track) => track.name);
    const press = (key: string) =>
      fireAndFlush(() =>
        fireEvent.keyDown(document.activeElement ?? document.body, { key }),
      );

    const edit = screen.getByRole("button", { name: `Edit ${first.name}` });
    edit.focus();
    press("ArrowRight");
    expect(names()).toEqual([second.name, first.name]);
    const reordered = transport.named("track_reordered");
    expect(reordered).toHaveLength(1);
    expect(reordered[0].params).toMatchObject({ view: "mixer", method: "keyboard" });

    // Already last: nothing moves, and nothing is logged.
    screen.getByRole("button", { name: `Edit ${first.name}` }).focus();
    press("ArrowRight");
    expect(names()).toEqual([second.name, first.name]);
    expect(transport.named("track_reordered")).toHaveLength(1);

    // On a fader the arrows are the fader's: no track moves.
    screen.getByLabelText(`Volume for ${first.name}`).focus();
    press("ArrowLeft");
    expect(names()).toEqual([second.name, first.name]);
  });

  it("logs track_reordered once per move-left/right press (#331)", () => {
    const { history, transport } = renderMixer(createDrumMachineFixtureProject());
    const [first] = history.project.song.tracks;

    clickAndFlush(screen.getByRole("button", { name: `Move ${first.name} right` }));

    const events = transport.named("track_reordered");
    expect(events).toHaveLength(1);
    expect(events[0]?.params).toMatchObject({ view: "mixer", method: "button" });
    expect(history.entries).toHaveLength(1);
  });

  it("drags a strip along the row to reorder it, previewing it in its new place (#331)", async () => {
    const { history, transport, selected } = renderMixer(
      createReferenceProject({ trackCount: 3, placementCount: 3 }),
    );
    const order = () =>
      [...history.project.song.tracks].sort((a, b) => a.order - b.order);
    stubTrackDragLayout({
      axis: "x",
      zoneSelector: ".mixer-tracks",
      size: 100,
      zoneLength: 300,
      order: () => order().map((track) => track.id),
    });
    const [a, b, c] = order();
    const edit = (name: string) => screen.getByRole("button", { name: `Edit ${name}` });

    dragTrackHandle(edit(c.name), { x: 2, y: 50 }, () => {
      // Mid-drag the strip is already shown where it will land, dimmed, while
      // the project is untouched until release.
      const shown = [...document.querySelectorAll<HTMLElement>("[data-track-drag]")];
      expect(shown.map((strip) => strip.dataset.trackDrag)).toEqual([c.id, a.id, b.id]);
      expect(screen.getByTestId("track-drop-indicator")).toBe(shown[0]);
      expect(shown[0]).toHaveClass("track-dragging");
      expect(order().map((track) => track.id)).toEqual([a.id, b.id, c.id]);
      expect(history.entries).toHaveLength(0);
    });

    expect(screen.queryByTestId("track-drop-indicator")).toBeNull();
    expect(order().map((track) => track.id)).toEqual([c.id, a.id, b.id]);
    expect(history.entries).toHaveLength(1);
    expect(transport.named("track_reordered").map((event) => event.params)).toEqual([
      expect.objectContaining({ view: "mixer", method: "drag" }),
    ]);

    // Released past the row's end: nothing moves, nothing is logged.
    dragTrackHandle(edit(a.name), { x: 900, y: 50 });
    expect(order().map((track) => track.id)).toEqual([c.id, a.id, b.id]);
    expect(transport.named("track_reordered")).toHaveLength(1);
    expect(selected).toEqual([]);
    // Let the swallow for the click a drag ends in lapse, as a browser would
    // by the next task, so it cannot eat the next test's first click.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("starts a drag from anywhere on the strip background, never from its controls (#331)", async () => {
    const { history } = renderMixer(
      createReferenceProject({ trackCount: 3, placementCount: 3 }),
    );
    const order = () =>
      [...history.project.song.tracks].sort((a, b) => a.order - b.order);
    stubTrackDragLayout({
      axis: "x",
      zoneSelector: ".mixer-tracks",
      size: 100,
      zoneLength: 300,
      order: () => order().map((track) => track.id),
    });
    const [a, b, c] = order();
    const strip = (name: string) =>
      screen
        .getByRole("button", { name: `Edit ${name}` })
        .closest<HTMLElement>("[data-track-drag]") as HTMLElement;

    // The strip's own background is a handle.
    dragTrackHandle(strip(c.name), { x: 2, y: 50 });
    expect(order().map((track) => track.id)).toEqual([c.id, a.id, b.id]);
    expect(history.entries).toHaveLength(1);

    // Its controls keep their own gestures: a press-and-move on a button or a
    // slider moves no track.
    dragTrackHandle(screen.getByRole("button", { name: `Mute ${b.name}` }), {
      x: 2,
      y: 50,
    });
    dragTrackHandle(within(strip(b.name)).getAllByRole("slider")[0], { x: 2, y: 50 });
    expect(order().map((track) => track.id)).toEqual([c.id, a.id, b.id]);
    expect(history.entries).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("deletes an empty track immediately, warns on a track with clips", () => {
    const { history } = renderMixer(createDrumMachineFixtureProject());
    const trackWithClips = history.project.song.tracks[0];

    clickAndFlush(screen.getByRole("button", { name: `Delete ${trackWithClips.name}` }));
    // A confirmation dialog appears rather than deleting outright.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(history.project.song.tracks).toHaveLength(2);

    clickAndFlush(screen.getByRole("button", { name: "Delete track" }));
    expect(history.project.song.tracks.some((t) => t.id === trackWithClips.id)).toBe(
      false,
    );
  });

  it("duplicates a track deeply, with fresh clip IDs and a track_added event", () => {
    const { history, transport } = renderMixer(createDrumMachineFixtureProject());
    const source = history.project.song.tracks[0];
    const sourceClipIds = new Set(
      history.project.clips.filter((c) => c.trackId === source.id).map((c) => c.id),
    );

    clickAndFlush(screen.getByRole("button", { name: `Duplicate ${source.name}` }));

    expect(history.project.song.tracks).toHaveLength(3);
    const copy = history.project.song.tracks.find(
      (t) => t.name === `${source.name} copy`,
    );
    expect(copy).toBeDefined();
    if (!copy) return;
    const copyClips = history.project.clips.filter((c) => c.trackId === copy.id);
    expect(copyClips.length).toBeGreaterThan(0);
    for (const clip of copyClips) {
      expect(sourceClipIds.has(clip.id)).toBe(false);
    }
    expect(transport.events.filter((e) => e.name === "track_added")).toHaveLength(1);
  });
});

describe("Mixer controls (TRK-02)", () => {
  it("toggles mute and solo through commands, keyboard accessible", () => {
    const { history } = renderMixer();
    const track = history.project.song.tracks[0];

    const mute = screen.getByRole("button", { name: `Mute ${track.name}` });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    clickAndFlush(mute);
    expect(history.project.song.tracks[0].mixer.muted).toBe(true);

    const solo = screen.getByRole("button", { name: `Solo ${track.name}` });
    clickAndFlush(solo);
    expect(history.project.song.tracks[0].mixer.soloed).toBe(true);
  });

  it("a fader drag commits as exactly one history entry, not one per move", () => {
    const { history } = renderMixer();
    const startRevision = history.project.metadata.revision;
    const fader = screen.getByLabelText(
      `Volume for ${history.project.song.tracks[0].name}`,
    ) as HTMLInputElement;

    // A range input streams `input` while the pointer moves and fires one
    // `change` on release — the gesture opens on the first and closes on it.
    for (const position of [0.6, 0.55, 0.5, 0.45]) {
      fader.value = String(position);
      fireEvent.input(fader);
      flush();
    }
    fireEvent.change(fader);
    flush();

    // One drag = one revision bump, regardless of how many input events fired.
    expect(history.project.metadata.revision).toBe(startRevision + 1);
    expect(history.entries).toHaveLength(1);
  });

  it("a pan drag commits as exactly one history entry", () => {
    const { history } = renderMixer();
    const startRevision = history.project.metadata.revision;
    const pan = screen.getByLabelText(
      `Pan for ${history.project.song.tracks[0].name}`,
    ) as HTMLInputElement;

    for (const value of [0.2, 0.4, 0.6]) {
      pan.value = String(value);
      fireEvent.input(pan);
      flush();
    }
    fireEvent.change(pan);
    flush();

    expect(history.project.metadata.revision).toBe(startRevision + 1);
    expect(history.entries).toHaveLength(1);
  });

  it("double-clicking a volume fader resets it to 0 dB as one history entry (#536)", () => {
    const { history } = renderMixer();
    const track = history.project.song.tracks[0];
    const fader = screen.getByLabelText(`Volume for ${track.name}`) as HTMLInputElement;
    fader.value = "0.3";
    fireEvent.input(fader);
    fireEvent.change(fader);
    flush();
    expect(history.project.song.tracks[0].mixer.volume).not.toBe(0);
    const before = history.entries.length;

    fireEvent.dblClick(fader);
    flush();

    expect(history.project.song.tracks[0].mixer.volume).toBe(0);
    expect(history.entries).toHaveLength(before + 1);
  });

  it("double-clicking a pan control resets it to centre as one history entry (#536)", () => {
    const { history } = renderMixer();
    const pan = screen.getByLabelText(
      `Pan for ${history.project.song.tracks[0].name}`,
    ) as HTMLInputElement;
    pan.value = "0.6";
    fireEvent.input(pan);
    fireEvent.change(pan);
    flush();
    expect(history.project.song.tracks[0].mixer.pan).toBe(0.6);
    const before = history.entries.length;

    fireEvent.dblClick(pan);
    flush();

    expect(history.project.song.tracks[0].mixer.pan).toBe(0);
    expect(history.entries).toHaveLength(before + 1);
  });

  it("shows a human-readable dB value and a pan readout", () => {
    const { history } = renderMixer();
    const track = history.project.song.tracks[0];
    // Default volume 0 dB, default pan centre.
    // Every track strip and the master read 0 dB by default.
    expect(screen.getAllByDisplayValue("0.0 dB").length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue("C").length).toBeGreaterThan(0);
    // The fader carries the readable value for assistive tech.
    const fader = screen.getByLabelText(`Volume for ${track.name}`);
    expect(fader).toHaveAttribute("aria-valuetext", "0.0 dB");
  });

  it("takes a typed volume in decibels as one history entry (#447)", () => {
    const { history } = renderMixer();
    const track = history.project.song.tracks[0];
    const startRevision = history.project.metadata.revision;
    const field = screen.getByLabelText(
      `Volume for ${track.name} value`,
    ) as HTMLInputElement;

    field.value = "-6";
    fireEvent.change(field);
    flush();

    expect(history.project.song.tracks[0].mixer.volume).toBeCloseTo(-6);
    expect(history.project.metadata.revision).toBe(startRevision + 1);
    expect(history.entries).toHaveLength(1);
    expect(field.value).toBe("-6.0 dB");
  });

  it("builds volume and pan from the shared fill slider, one id per control", () => {
    const { history } = renderMixer(createDrumMachineFixtureProject());
    const trackCount = history.project.song.tracks.length;

    // The design language has exactly one continuous control (mock 06c), so a
    // mixer strip must not grow a second, differently-behaving slider.
    const sliders = Array.from(
      document.querySelectorAll<HTMLInputElement>(".fill-slider-input"),
    );
    // Volume and pan per track, and the master's volume (#447).
    expect(sliders).toHaveLength(trackCount * 2 + 1);
    // Volume and pan appear once per track, so their ids have to be per-track:
    // a duplicated id would point every strip's <label> at the same input.
    const ids = sliders.map((input) => input.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The fader travels in perceptual fader positions, not raw decibels.
    const fader = screen.getByLabelText(
      `Volume for ${history.project.song.tracks[0].name}`,
    ) as HTMLInputElement;
    expect(fader.min).toBe("0");
    expect(fader.max).toBe("1");
  });

  it("lays pan out horizontally and fills it out from centre", () => {
    const { history } = renderMixer();
    const track = history.project.song.tracks[0];
    const pan = screen.getByLabelText(`Pan for ${track.name}`) as HTMLInputElement;
    const fader = screen.getByLabelText(`Volume for ${track.name}`);

    // Pan's range is the stereo field, so it moves the way the field reads —
    // left-to-right — while the fader stays vertical.
    expect(pan).toHaveAttribute("aria-orientation", "horizontal");
    expect(fader).toHaveAttribute("aria-orientation", "vertical");

    const slider = pan.closest(".fill-slider");
    const fill = slider?.querySelector<HTMLElement>(".fill-slider-fill");
    expect(slider?.classList.contains("horizontal")).toBe(true);
    expect(slider?.classList.contains("bipolar")).toBe(true);

    // Centre pans paint at the centre, not half a track of accent.
    expect(fill?.style.left).toBe("50%");
    expect(fill?.style.width).toBe("0%");

    // Panned left, the fill runs from the value back to the centre; panned
    // right, from the centre out to the value.
    pan.value = "-0.5";
    fireEvent.change(pan);
    flush();
    expect(fill?.style.left).toBe("25%");
    expect(fill?.style.width).toBe("25%");

    pan.value = "1";
    fireEvent.change(pan);
    flush();
    expect(fill?.style.left).toBe("50%");
    expect(fill?.style.width).toBe("50%");
  });

  it("lands a value from a change that had no preceding input", () => {
    const { history } = renderMixer();
    const pan = screen.getByLabelText(
      `Pan for ${history.project.song.tracks[0].name}`,
    ) as HTMLInputElement;

    pan.value = "-0.5";
    fireEvent.change(pan);
    flush();

    expect(history.project.song.tracks[0].mixer.pan).toBeCloseTo(-0.5);
  });

  it("renders a level meter per track, and one for the master", () => {
    const { history } = renderMixer(createDrumMachineFixtureProject());
    const meters = screen.getAllByRole("meter", { name: "Level" });
    expect(meters).toHaveLength(history.project.song.tracks.length);
    expect(screen.getAllByRole("meter", { name: "Master level" })).toHaveLength(1);
  });
});

describe("Mixer track selection (#228)", () => {
  it("selects a track from its strip, and marks the selected one", () => {
    const { history, selected } = renderMixer(createDrumMachineFixtureProject());
    const [drums, breakTrack] = history.project.song.tracks;

    const select = (name: string) => screen.getByRole("button", { name: `Edit ${name}` });
    expect(select(drums.name)).toHaveAttribute("aria-pressed", "false");

    clickAndFlush(select(breakTrack.name));

    expect(selected).toEqual([breakTrack.id]);
    expect(select(breakTrack.name)).toHaveAttribute("aria-pressed", "true");
    expect(select(drums.name)).toHaveAttribute("aria-pressed", "false");
    expect(select(breakTrack.name).closest(".mixer-strip")?.classList).toContain(
      "selected",
    );
  });

  it("selects a track when its strip is clicked or a value on it changes (#447)", () => {
    const { history, selected } = renderMixer(createDrumMachineFixtureProject());
    const [drums, breakTrack] = history.project.song.tracks;
    const strip = (name: string) =>
      screen
        .getByRole("button", { name: `Edit ${name}` })
        .closest(".mixer-strip") as HTMLElement;

    // A click on the strip itself, not on a control.
    clickAndFlush(strip(breakTrack.name));
    expect(selected).toEqual([breakTrack.id]);

    // Muting another track selects it too.
    clickAndFlush(screen.getByRole("button", { name: `Mute ${drums.name}` }));
    expect(selected).toEqual([breakTrack.id, drums.id]);

    // So does moving a fader on a strip that is not selected.
    const volume = screen.getByLabelText(
      `Volume for ${breakTrack.name}`,
    ) as HTMLInputElement;
    fireEvent.input(volume, { target: { value: "-6" } });
    flush();
    expect(selected).toEqual([breakTrack.id, drums.id, breakTrack.id]);

    // A strip that is already selected is not selected again.
    fireEvent.input(volume, { target: { value: "-9" } });
    flush();
    expect(selected).toHaveLength(3);
  });

  it("leaves every other control on the strip working", () => {
    // Selection used to be a `pointerdown` handler on the whole strip. WebKit
    // fires no click at all when mousedown and mouseup land on different
    // elements, so the re-render that handler caused swallowed the delete
    // button's own click (seen in WebKit only). Nothing on the
    // strip may cost a control its press.
    const { history, selected } = renderMixer(createDrumMachineFixtureProject());
    const withClips = history.project.song.tracks[0];

    const del = screen.getByRole("button", {
      name: `Delete ${withClips.name}`,
    });
    fireEvent.pointerDown(del);
    flush();
    clickAndFlush(del);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    // ...and pressing it selected nothing: only the Edit control does that.
    expect(selected).toEqual([]);
  });

  it("counts selecting a track as mixer use, with no event of its own", () => {
    const { history, transport } = renderMixer(createDrumMachineFixtureProject());
    const breakTrack = history.project.song.tracks[1];

    clickAndFlush(screen.getByRole("button", { name: `Edit ${breakTrack.name}` }));

    const events = transport.events.filter((event) => event.name === "feature_first_use");
    expect(events).toHaveLength(1);
    expect(events[0]?.params.feature).toBe("mixer");
    // Selection is not a tracked action of its own: nothing else is logged.
    expect(transport.events).toHaveLength(1);
  });
});

/** The master, and its chain (`UI-001`, #283). */
describe("Mixer master strip", () => {
  const masterEffects = () => screen.getByRole("region", { name: "Master effects" });

  it("shows the master's effects without being asked", () => {
    renderMixer();

    // There is exactly one master and exactly one master chain, so there is
    // nothing to choose between: it is on screen with the strips it applies
    // to, empty until something is added to it.
    expect(masterEffects()).toBeVisible();
    expect(screen.getByRole("list", { name: "Master chain" })).toBeEmptyDOMElement();
  });

  it("takes you to the master's effects when the master strip is selected", async () => {
    renderMixer();

    clickAndFlush(screen.getByRole("button", { name: "Master" }));
    // Focus moves once the selection's flush has mounted the panel (#1106).
    await Promise.resolve();

    // Nothing is revealed or hidden — the chain was already there — but the
    // strip is the way in for a keyboard, so focus lands in the panel.
    expect(masterEffects()).toHaveFocus();
  });

  it("adds to the master chain through the device commands, as one entry", () => {
    const { history, transport } = renderMixer();

    clickAndFlush(screen.getByRole("button", { name: "Add overdrive device" }));

    expect(history.project.song.master.devices.map((d) => d.type)).toEqual(["overdrive"]);
    expect(history.entries).toHaveLength(1);
    expect(screen.getByRole("slider", { name: "Drive" })).toBeVisible();
    const added = transport.events.filter((e) => e.name === "device_added");
    expect(added).toHaveLength(1);
    expect(added[0].params).toMatchObject({ device_type: "overdrive", chain: "master" });
  });

  it("keeps the master's effects on screen while a track's strip is chosen", () => {
    const { history } = renderMixer();

    clickAndFlush(
      screen.getByRole("button", { name: `Edit ${history.project.song.tracks[0].name}` }),
    );

    // Choosing a track is not a reason to hide the master: the master is what
    // everything, including that track, is going through.
    expect(masterEffects()).toBeVisible();
  });
});

describe("Mixer desk (#447)", () => {
  it("meters the mix on the master strip, red when it clips (GRV-44)", () => {
    const [level, setLevel] = createSignal<TrackLevel | null>(null);
    renderMixer(createSliceFixtureProject(), level);
    const meter = screen.getByRole("meter", { name: "Master level" });

    // At rest, nothing plays: the meter sits at its floor.
    expect(meter).toHaveAttribute("value", "-60");
    setLevel({ db: -12, clipping: false });
    flush();
    expect(meter).toHaveAttribute("value", "-12");
    expect(meter.parentElement).not.toHaveClass("clipping");

    // A peak over 0 dBFS on the mix lights it, as a track's meter does.
    setLevel({ db: -2, clipping: true });
    flush();
    expect(meter.parentElement).toHaveClass("clipping");
  });

  it("gives the master a volume fader at the end of the desk, one entry per edit", () => {
    const { history } = renderMixer();
    const startRevision = history.project.metadata.revision;
    const field = screen.getByLabelText("Master volume value") as HTMLInputElement;

    field.value = "-6";
    fireEvent.change(field);
    flush();

    expect(history.project.song.master.volume).toBeCloseTo(-6);
    expect(history.project.metadata.revision).toBe(startRevision + 1);
    expect(screen.getByRole("slider", { name: "Master volume" })).toBeInTheDocument();
    // The master strip closes the desk, after every track strip.
    const desk = document.querySelector(".mixer-desk");
    expect(desk?.lastElementChild).toHaveClass("mixer-master-strip");
  });

  it("marks the mixer's first use once for a master drag, not per step", () => {
    const { transport } = renderMixer();
    const fader = screen.getByRole("slider", { name: "Master volume" });
    for (const value of ["0.7", "0.6", "0.5"]) {
      fireEvent.input(fader, { target: { value } });
    }
    fireEvent.change(fader, { target: { value: "0.5" } });
    flush();
    const firstUse = transport.events.filter((e) => e.name === "feature_first_use");
    expect(firstUse).toHaveLength(1);
    expect(firstUse[0]?.params.feature).toBe("mixer");
  });

  it("names the chain each strip carries, in signal order", () => {
    expect(chainSummary([])).toBe("No devices");
    const ids = createSeededIdFactory("mixer-chain");
    expect(
      chainSummary([
        createDevice(ids("device"), "filter", 0),
        createDevice(ids("device"), "delay", 1),
      ]),
    ).toBe("Filter · Delay");
    renderMixer();
    expect(screen.getAllByText("No devices").length).toBeGreaterThan(0);
  });
});

describe("Mixer strip head and title (#447)", () => {
  it("titles the view, with the new-track buttons in the same row", () => {
    renderMixer();
    const header = screen.getByRole("heading", { level: 2, name: "Mixer" }).parentElement;
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement).getByRole("group", { name: "Add track" }),
    ).toBeInTheDocument();
  });

  it("names each strip's track and kind, with its colour as the top edge", () => {
    const { project } = renderMixer();
    const track = project().song.tracks[0];
    const select = screen.getByRole("button", { name: `Edit ${track.name}` });
    expect(select.textContent).toBe("Sampler");
    const head = select.parentElement as HTMLElement;
    expect(head.style.borderTopColor).not.toBe("");
    expect(within(head).getByLabelText("Track name")).toHaveValue(track.name);

    clickAndFlush(select);
    expect(select.closest(".mixer-strip")?.classList.contains("selected")).toBe(true);
  });
});
