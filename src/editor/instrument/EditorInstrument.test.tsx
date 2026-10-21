import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistory, updateTrack } from "../../commands";
import type { Project } from "../../domain/entities";
import {
  createDrumMachineFixtureProject,
  createReferenceProject,
} from "../../domain/fixtures";
import type { PadId, TrackId } from "../../domain/ids";
import { clickAndFlush } from "../../testing/events";
import EditorInstrument from "./EditorInstrument";

afterEach(() => cleanup());

type Scope = () => ReturnType<typeof within>;

function addFromPanel(panel: Scope, label: string) {
  clickAndFlush(
    panel().getByRole("button", { name: `Add ${label.toLowerCase()} device` }),
  );
}

describe("the Instrument view's device chain", () => {
  it("follows the selected track, with no selection of its own", () => {
    const history = new CommandHistory(createReferenceProject());
    const tracks = history.project.song.tracks;
    expect(tracks.length).toBeGreaterThan(1);
    const [project, setProject] = createSignal<Project>(history.project);
    history.subscribe(() => setProject(history.project));
    const [selected, setSelected] = createSignal<TrackId>(tracks[0].id);
    const track = () =>
      project().song.tracks.find((candidate) => candidate.id === selected()) ?? null;
    render(() => (
      <EditorInstrument
        project={project()}
        track={track()}
        drumTrack={null}
        sampleAssets={[]}
        instrument={track()?.instrument ?? null}
        instrumentTrackId={track()?.id ?? null}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={() => {}}
        onBrowse={() => {}}
        onSelectTrack={(id) => setSelected(id)}
        dispatch={(commands) => history.execute(commands)}
        beginGesture={(gesture) => history.beginGesture(gesture)}
      />
    ));
    const panel = () => within(screen.getByRole("region", { name: "Device chain" }));
    const count = () =>
      within(panel().getByRole("list", { name: "Device chain" })).queryAllByRole(
        "listitem",
      ).length;
    const initial = tracks.map((candidate) => candidate.devices.length);

    addFromPanel(panel, "Reverb");
    expect(project().song.tracks[0].devices).toHaveLength(initial[0] + 1);
    expect(count()).toBe(initial[0] + 1);

    const rail = within(screen.getByRole("list", { name: "Tracks" })).getAllByRole(
      "button",
      { name: /^Edit / },
    );
    clickAndFlush(rail[1]);
    expect(count()).toBe(initial[1]);
    expect(project().song.tracks[1].devices).toHaveLength(initial[1]);
    clickAndFlush(rail[0]);
    expect(count()).toBe(initial[0] + 1);
  });
});

describe("the Instrument view on a loop track (#447)", () => {
  it("shows a loop panel, under a disabled picker, on an audio track", () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find((candidate) => candidate.type === "audio");
    if (!track) throw new Error("fixture has no audio track");
    render(() => (
      <EditorInstrument
        project={project}
        track={track}
        drumTrack={null}
        sampleAssets={[]}
        instrument={null}
        instrumentTrackId={track.id}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={() => {}}
        onBrowse={() => {}}
        onSelectTrack={() => {}}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));

    expect(
      screen.getByRole("region", { name: `${track.name} loop` }),
    ).toBeInTheDocument();
    // The picker still heads the view, with nothing to choose (#447).
    const picker = screen.getByRole("region", { name: "Instrument" });
    const kinds = within(picker).getAllByRole("radio");
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(kind).toBeDisabled();
      expect(kind).not.toBeChecked();
    }
    // The loop's chain is still there beneath it.
    expect(screen.getByRole("region", { name: "Device chain" })).toBeInTheDocument();
  });
});

describe("the Instrument view on a drum machine (#447)", () => {
  it("puts the kind picker above the pad panel", () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find(
      (candidate) => candidate.instrument?.kind === "drumMachine",
    );
    if (!track) throw new Error("fixture has no drum machine");
    render(() => (
      <EditorInstrument
        project={project}
        track={track}
        drumTrack={track}
        sampleAssets={project.song.assets}
        instrument={track.instrument}
        instrumentTrackId={track.id}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={() => {}}
        onBrowse={() => {}}
        onSelectTrack={() => {}}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));

    const picker = screen.getByRole("region", { name: "Instrument" });
    const pads = screen.getByRole("region", { name: `Drum machine: ${track.name}` });
    expect(
      picker.compareDocumentPosition(pads) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("the Instrument view's header (#447)", () => {
  it("names the track and plays the selected pad from its Audition", () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find(
      (candidate) => candidate.instrument?.kind === "drumMachine",
    );
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [first, second] = track.instrument.pads;
    const auditionPad = vi.fn();
    render(() => (
      <EditorInstrument
        project={project}
        track={track}
        drumTrack={track}
        sampleAssets={project.song.assets}
        instrument={track.instrument}
        instrumentTrackId={track.id}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={auditionPad}
        onBrowse={() => {}}
        onSelectTrack={() => {}}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));

    const header = within(document.querySelector(".instrument-header") as HTMLElement);
    // No level source, no meter.
    expect(header.queryByRole("meter")).toBeNull();
    expect(header.getByText("T01 · Drum machine")).toBeInTheDocument();
    expect(header.getByText(track.name)).toBeInTheDocument();
    expect(header.getByText(first.name)).toBeInTheDocument();

    // Selecting a pad in the table moves the header, and its Audition, to it.
    const rows = document.querySelectorAll(".drum-pad:not(.drum-pad-head)");
    clickAndFlush(rows[1].querySelector(".pad-index") as HTMLElement);
    expect(header.getByText(second.name)).toBeInTheDocument();
    clickAndFlush(header.getByRole("button", { name: "Audition pad" }));
    expect(auditionPad).toHaveBeenCalledExactlyOnceWith(track.id, second.id);
  });
});

describe("the Instrument view's pad selection (#643)", () => {
  it("shows and reports the pad the host owns, so the step grid shares it", () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks.find(
      (candidate) => candidate.instrument?.kind === "drumMachine",
    );
    if (track?.instrument?.kind !== "drumMachine") throw new Error("no drum machine");
    const [first, second] = track.instrument.pads;
    const [selected, setSelected] = createSignal<PadId | null>(second.id);
    const onSelectPad = vi.fn();
    render(() => (
      <EditorInstrument
        project={project}
        track={track}
        drumTrack={track}
        sampleAssets={project.song.assets}
        instrument={track.instrument}
        instrumentTrackId={track.id}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={() => {}}
        onBrowse={() => {}}
        onSelectTrack={() => {}}
        selectedPadId={selected()}
        onSelectPad={onSelectPad}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));

    // Chosen elsewhere (the step grid's row), shown here.
    expect(screen.getByRole("region", { name: `${second.name} pad` })).toBeVisible();
    setSelected(first.id);
    flush();
    expect(screen.getByRole("region", { name: `${first.name} pad` })).toBeVisible();

    // Chosen here, reported to the host for the step grid.
    const rows = document.querySelectorAll(".drum-pad:not(.drum-pad-head)");
    clickAndFlush(rows[1].querySelector(".pad-index") as HTMLElement);
    expect(onSelectPad).toHaveBeenCalledExactlyOnceWith(track.id, second.id);
  });
});

describe("the Instrument view's header meter (#447)", () => {
  it("shows the track's live level beside Audition", () => {
    const project = createDrumMachineFixtureProject();
    const track = project.song.tracks[0];
    render(() => (
      <EditorInstrument
        project={project}
        track={track}
        drumTrack={track.instrument?.kind === "drumMachine" ? track : null}
        sampleAssets={project.song.assets}
        instrument={track.instrument}
        instrumentTrackId={track.id}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={() => {}}
        onBrowse={() => {}}
        onSelectTrack={() => {}}
        dispatch={() => undefined}
        beginGesture={() => undefined}
        trackLevel={() => null}
      />
    ));
    const header = document.querySelector(".instrument-header") as HTMLElement;
    expect(within(header).getByRole("meter", { name: "Level" })).toBeInTheDocument();
  });
});

describe("the Instrument view's header across edits (#447)", () => {
  it("keeps one header while the track is edited", () => {
    const history = new CommandHistory(createReferenceProject());
    const [project, setProject] = createSignal<Project>(history.project);
    history.subscribe(() => setProject(history.project));
    const trackId = history.project.song.tracks[0].id;
    const track = () =>
      project().song.tracks.find((candidate) => candidate.id === trackId) ?? null;
    render(() => (
      <EditorInstrument
        project={project()}
        track={track()}
        drumTrack={null}
        sampleAssets={[]}
        instrument={track()?.instrument ?? null}
        instrumentTrackId={track()?.id ?? null}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={() => {}}
        onBrowse={() => {}}
        onSelectTrack={() => {}}
        dispatch={(commands) => history.execute(commands)}
        beginGesture={(gesture) => history.beginGesture(gesture)}
        trackLevel={() => null}
      />
    ));
    const header = document.querySelector(".instrument-header");
    const meter = within(header as HTMLElement).getByRole("meter", { name: "Level" });

    history.execute(updateTrack(trackId, { name: "Renamed" }));
    flush();

    // The same header, and the same meter, now naming the renamed track.
    expect(document.querySelector(".instrument-header")).toBe(header);
    expect(within(header as HTMLElement).getByRole("meter", { name: "Level" })).toBe(
      meter,
    );
    expect(header).toHaveTextContent("Renamed");
  });
});

describe("the Instrument view's header across track kinds (#447)", () => {
  it("heads a loop track's panel after an instrument track's, and back", () => {
    const project = createDrumMachineFixtureProject();
    const drums = project.song.tracks.find((t) => t.type === "instrument");
    const loop = project.song.tracks.find((t) => t.type === "audio");
    if (!drums || !loop) throw new Error("fixture lacks a drum or loop track");
    const [track, setTrack] = createSignal(drums);
    render(() => (
      <EditorInstrument
        project={project}
        track={track()}
        drumTrack={track().type === "instrument" ? track() : null}
        sampleAssets={project.song.assets}
        instrument={track().instrument}
        instrumentTrackId={track().id}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={() => {}}
        onBrowse={() => {}}
        onSelectTrack={() => {}}
        dispatch={() => undefined}
        beginGesture={() => undefined}
      />
    ));
    const headers = () => document.querySelectorAll(".instrument-header");
    expect(headers()).toHaveLength(1);

    setTrack(loop);
    flush();
    expect(headers()).toHaveLength(1);
    expect(screen.getByRole("region", { name: `${loop.name} loop` })).toContainElement(
      headers()[0] as HTMLElement,
    );
    expect(headers()[0]).toHaveTextContent(loop.name);

    setTrack(drums);
    flush();
    expect(headers()).toHaveLength(1);
    expect(headers()[0]).toHaveTextContent(drums.name);
  });
});
