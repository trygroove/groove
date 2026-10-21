import { createRouter, memoryHistory, useLocation, useNavigate } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { ROW_METRICS } from "../../arrangement/ArrangementView";
import { installWebAudioGlobals } from "../../audio/testAudioContext";
import { type ControlAddress, controlKey } from "../../commands/controlAddress";
import { createDevice } from "../../domain/devices";
import type { Project } from "../../domain/entities";
import {
  createFactoryContext,
  createSynthInstrument,
  createTrack,
} from "../../domain/factories";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory, type DeviceId } from "../../domain/ids";
import type { InMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import type { EditorControls } from "./editorControls";
import { editorViewFromPath, editorViewPath } from "./editorViews";

/**
 * The editor's controls carry their addresses (`UI-004`, #850): every control
 * the issue names — mixer volume and pan, tempo and swing, a device parameter,
 * an instrument parameter, a clip's notes — registers under the address
 * `controlsTouchedBy` gives the command that changes it, can be revealed from
 * any view, and wears the mark set on its address.
 */

installWebAudioGlobals();

let AudioRuntimeModule: typeof import("../../audio/AudioRuntime");
let inMemoryModule: typeof import("../../persistence/inMemoryProjectRepository");
let EditorViewModule: typeof import("./EditorView");

beforeAll(async () => {
  AudioRuntimeModule = await import("../../audio/AudioRuntime");
  inMemoryModule = await import("../../persistence/inMemoryProjectRepository");
  EditorViewModule = await import("./EditorView");
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  try {
    await AudioRuntimeModule.getAudioRuntime().close();
  } catch {
    // already closed
  }
  AudioRuntimeModule.__resetAudioRuntimeForTests();
});

let repository: InMemoryProjectRepository;

vi.mock("../../projectRepositoryClient", () => ({
  getProjectRepository: () => Promise.resolve(repository),
}));

/**
 * The slice fixture with a filter on its sampler track, so a device is on
 * screen, and a second (synth) track to select away from it.
 */
function projectWithDevice(): { project: Project; deviceId: DeviceId } {
  const project = createSliceFixtureProject();
  const ids = createSeededIdFactory("controls");
  const deviceId = ids("device");
  const [track] = project.song.tracks;
  const lead = createTrack(createFactoryContext({ ids }), {
    name: "Lead",
    order: 1,
    instrument: createSynthInstrument(),
  });
  return {
    deviceId,
    project: {
      ...project,
      song: {
        ...project.song,
        tracks: [{ ...track, devices: [createDevice(deviceId, "filter", 0)] }, lead],
      },
    },
  };
}

async function openProject(
  project: Project,
  analytics?: Analytics,
): Promise<EditorControls> {
  let controls: EditorControls | undefined;
  repository = inMemoryModule.createInMemoryProjectRepository();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture project failed to create");
  const projectId = project.metadata.id;
  const EditorView = EditorViewModule.default;
  const Page = () => {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <EditorView
        projectId={projectId}
        view={editorViewFromPath(location.pathname)}
        viewHref={(view) => editorViewPath(projectId, view)}
        onSelectView={(view) => navigate(editorViewPath(projectId, view))}
        analytics={analytics}
        onControlsReady={(ready) => {
          controls = ready;
        }}
      />
    );
  };
  const TestRouter = createRouter({
    history: memoryHistory(editorViewPath(projectId, "arrangement")),
    routes: [{ path: "/projects/:id/:view?", component: Page }],
  });
  render(() => <TestRouter />);
  await screen.findByRole("navigation", { name: "Views" });
  if (!controls) throw new Error("the editor never handed over its controls");
  return controls;
}

async function goToView(label: "Arrangement" | "Instrument" | "Mixer"): Promise<void> {
  const dock = await screen.findByRole("navigation", { name: "Views" });
  clickAndFlush(within(dock).getByRole("link", { name: label }));
  await vi.waitFor(() =>
    expect(dock.querySelector("[aria-current='page']")).toHaveAccessibleName(label),
  );
}

/** Opens the clip at bar 1 of the first row by double-clicking the timeline. */
async function openSequenceEditor(): Promise<HTMLElement> {
  await screen.findByTestId("arrangement-view-ready");
  const canvas = document.querySelector(".arrangement-layer-interactive");
  if (!canvas) throw new Error("no arrangement interaction canvas rendered");
  fireAndFlush(() =>
    fireEvent.dblClick(canvas, {
      clientX: (768 / 2) * 0.08,
      clientY: 22 + ROW_METRICS.trackHeightPx * 0.5,
    }),
  );
  return screen.findByRole("region", { name: "Sequence editor" });
}

function controlsAt(address: ControlAddress): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(`[data-control="${controlKey(address)}"]`),
  ];
}

describe("EditorView control addresses (UI-004)", () => {
  it("addresses tempo and swing on the song, in every view", async () => {
    const { project } = projectWithDevice();
    await openProject(project);
    for (const view of ["Arrangement", "Instrument", "Mixer"] as const) {
      await goToView(view);
      const tempo = controlsAt({ entity: "song", param: "tempo" });
      expect(tempo, view).toHaveLength(1);
      expect(within(tempo[0]).getByLabelText("Tempo (BPM)")).toBeInTheDocument();
      const swing = controlsAt({ entity: "song", param: "swing" });
      expect(
        swing.map((element) => element.getAttribute("aria-label")),
        view,
      ).toEqual(["Swing"]);
    }
  });

  it("addresses the swing slider too, while its panel is open", async () => {
    await openProject(projectWithDevice().project);
    clickAndFlush(screen.getByRole("button", { name: "Swing" }));
    await vi.waitFor(() =>
      expect(controlsAt({ entity: "song", param: "swing" })).toHaveLength(2),
    );
  });

  it("addresses a track's mixer volume and pan, and the master's volume", async () => {
    const { project } = projectWithDevice();
    const [track] = project.song.tracks;
    await openProject(project);
    await goToView("Mixer");
    const mixer = screen.getByRole("region", { name: "Mixer" });
    const [volume] = controlsAt({ entity: track.id, param: "volume" });
    expect(mixer).toContainElement(volume);
    expect(
      within(volume).getByRole("slider", { name: `Volume for ${track.name}` }),
    ).toBeInTheDocument();
    const [pan] = controlsAt({ entity: track.id, param: "pan" });
    expect(
      within(pan).getByRole("slider", { name: `Pan for ${track.name}` }),
    ).toBeInTheDocument();
    expect(controlsAt({ entity: "master", param: "volume" })).toHaveLength(1);
    expect(controlsAt({ entity: track.id, param: "header" })).toHaveLength(1);
  });

  it("addresses the same volume on the track's header, so both are marked together", async () => {
    const { project } = projectWithDevice();
    const [track] = project.song.tracks;
    await openProject(project);
    await screen.findByTestId("arrangement-view-ready");
    expect(controlsAt({ entity: track.id, param: "volume" })).toHaveLength(1);
    expect(controlsAt({ entity: track.id, param: "header" })).toHaveLength(1);
  });

  it("addresses an instrument parameter on its track and a device parameter on its device", async () => {
    const { project, deviceId } = projectWithDevice();
    const [track] = project.song.tracks;
    await openProject(project);
    await goToView("Instrument");
    const [pitch] = controlsAt({ entity: track.id, param: "pitch" });
    expect(within(pitch).getByText("Pitch")).toBeInTheDocument();
    const [cutoff] = controlsAt({ entity: deviceId, param: "cutoff" });
    expect(within(cutoff).getByText("Cutoff")).toBeInTheDocument();
    // A switch is addressed like a fader.
    const [mode] = controlsAt({ entity: deviceId, param: "mode" });
    expect(mode.tagName).toBe("FIELDSET");
    expect(controlsAt({ entity: deviceId, param: "faceplate" })).toHaveLength(1);
  });

  it("addresses a clip's notes on the open sequence editor", async () => {
    const { project } = projectWithDevice();
    const [clip] = project.clips;
    await openProject(project);
    const editor = await openSequenceEditor();
    const [notes] = controlsAt({ entity: clip.id, param: "notes" });
    expect(editor).toContainElement(notes);
  });
});

/** The view the dock marks current. */
function currentView(): string | null {
  return (
    document
      .querySelector("nav[aria-label='Views'] [aria-current='page']")
      ?.getAttribute("aria-label") ?? null
  );
}

/** Waits for a reveal to land focus inside the part registered for `address`. */
async function expectFocusedIn(address: ControlAddress): Promise<HTMLElement> {
  let part: HTMLElement | undefined;
  await vi.waitFor(() => {
    part = controlsAt(address).find((element) =>
      element.contains(document.activeElement),
    );
    expect(part, `focus in ${controlKey(address)}`).toBeDefined();
  });
  return part as HTMLElement;
}

describe("revealControl (UI-004)", () => {
  it("reveals a track's mixer volume from the arrangement", async () => {
    const { project } = projectWithDevice();
    const [track] = project.song.tracks;
    const controls = await openProject(project);
    await screen.findByTestId("arrangement-view-ready");

    const before = controls.revealControl({ entity: track.id, param: "volume" });

    expect(before.view).toBe("arrangement");
    await vi.waitFor(() => expect(currentView()).toBe("Mixer"));
    await expectFocusedIn({ entity: track.id, param: "volume" });
    expect(document.activeElement).toHaveAccessibleName(`Volume for ${track.name}`);
  });

  it("moves to a control without taking focus when asked not to (GRV-5)", async () => {
    const { project } = projectWithDevice();
    const [track] = project.song.tracks;
    const controls = await openProject(project);
    await screen.findByTestId("arrangement-view-ready");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    controls.revealControl({ entity: track.id, param: "volume" }, { focus: false });

    await vi.waitFor(() => expect(currentView()).toBe("Mixer"));
    await vi.waitFor(() =>
      expect(controlsAt({ entity: track.id, param: "volume" }).length).toBeGreaterThan(0),
    );
    // Long enough for a focusing reveal to have found the fader and focused it.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("reveals a track's pan from the instrument view, selecting its track", async () => {
    const { project } = projectWithDevice();
    const [bd, lead] = project.song.tracks;
    const controls = await openProject(project);
    await goToView("Instrument");

    controls.revealControl({ entity: lead.id, param: "pan" });

    await vi.waitFor(() => expect(currentView()).toBe("Mixer"));
    await expectFocusedIn({ entity: lead.id, param: "pan" });
    expect(controlsAt({ entity: lead.id, param: "header" })[0]).toHaveClass("selected");
    expect(controlsAt({ entity: bd.id, param: "header" })[0]).not.toHaveClass("selected");
  });

  it("reveals tempo from the mixer without leaving it", async () => {
    const controls = await openProject(projectWithDevice().project);
    await goToView("Mixer");

    controls.revealControl({ entity: "song", param: "tempo" });

    await expectFocusedIn({ entity: "song", param: "tempo" });
    expect(document.activeElement).toHaveAccessibleName("Tempo (BPM)");
    expect(currentView()).toBe("Mixer");
  });

  it("reveals swing from the instrument view, on its button", async () => {
    const controls = await openProject(projectWithDevice().project);
    await goToView("Instrument");

    controls.revealControl({ entity: "song", param: "swing" });

    await expectFocusedIn({ entity: "song", param: "swing" });
    expect(document.activeElement).toHaveAccessibleName("Swing");
    expect(currentView()).toBe("Instrument");
  });

  it("reveals a device parameter from the mixer, in the instrument view", async () => {
    const { project, deviceId } = projectWithDevice();
    const controls = await openProject(project);
    await goToView("Mixer");

    controls.revealControl({ entity: deviceId, param: "cutoff" });

    await vi.waitFor(() => expect(currentView()).toBe("Instrument"));
    await expectFocusedIn({ entity: deviceId, param: "cutoff" });
    expect(document.activeElement).toHaveAttribute("type", "range");
  });

  it("reveals an instrument parameter from the arrangement, selecting its track", async () => {
    const { project } = projectWithDevice();
    const [, lead] = project.song.tracks;
    const controls = await openProject(project);
    await screen.findByTestId("arrangement-view-ready");

    controls.revealControl({ entity: lead.id, param: "filterCutoff" });

    await vi.waitFor(() => expect(currentView()).toBe("Instrument"));
    await expectFocusedIn({ entity: lead.id, param: "filterCutoff" });
    expect(screen.getByRole("region", { name: "Synth voice" })).toBeInTheDocument();
  });

  it("reveals a clip's notes from the mixer, in the sequence view", async () => {
    const { project } = projectWithDevice();
    const [clip] = project.clips;
    const controls = await openProject(project);
    await goToView("Mixer");

    controls.revealControl({ entity: clip.id, param: "notes" });

    await vi.waitFor(() => expect(currentView()).toBe("Sequence"));
    const editor = await screen.findByRole("region", { name: "Sequence editor" });
    const notes = await expectFocusedIn({ entity: clip.id, param: "notes" });
    expect(editor).toContainElement(notes);
  });

  it("logs the view switches a reveal and its restore make, once each, as a reveal", async () => {
    const transport = createRecordingTransport();
    const analytics = new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    analytics.setAccountType("anonymous");
    const { project } = projectWithDevice();
    const [track] = project.song.tracks;
    const controls = await openProject(project, analytics);
    await screen.findByTestId("arrangement-view-ready");

    const before = controls.revealControl({ entity: track.id, param: "volume" });
    await vi.waitFor(() => expect(currentView()).toBe("Mixer"));
    controls.restoreView(before);
    await vi.waitFor(() => expect(currentView()).toBe("Arrangement"));

    const switches = transport.events.filter((event) => event.name === "view_changed");
    expect(switches.map((event) => event.params)).toEqual([
      expect.objectContaining({ view: "mixer", via: "reveal" }),
      expect.objectContaining({ view: "arrangement", via: "reveal" }),
    ]);
  });

  it("reveals the track when a control has no home on screen", async () => {
    const { project } = projectWithDevice();
    const [track] = project.song.tracks;
    const controls = await openProject(project);
    await screen.findByTestId("arrangement-view-ready");

    // Schema v1 has no send fader yet: the address is real, its control is not.
    controls.revealControl({ entity: track.id, param: "sendLevel.ret_none" });

    await vi.waitFor(() => expect(currentView()).toBe("Mixer"));
    await expectFocusedIn({ entity: track.id, param: "header" });
  });

  it("returns where the editor was, and restoring it restores the view and the track", async () => {
    const { project, deviceId } = projectWithDevice();
    const [bd, lead] = project.song.tracks;
    const controls = await openProject(project);
    await goToView("Mixer");
    clickAndFlush(
      within(screen.getByRole("region", { name: "Mixer" })).getByRole("button", {
        name: `Edit ${lead.name}`,
      }),
    );
    await goToView("Instrument");
    expect(screen.getByRole("region", { name: "Synth voice" })).toBeInTheDocument();

    // The device is on the other track: revealing it moves both view and track.
    const before = controls.revealControl({ entity: deviceId, param: "cutoff" });
    await expectFocusedIn({ entity: deviceId, param: "cutoff" });
    expect(screen.queryByRole("region", { name: "Synth voice" })).toBeNull();
    controls.revealControl({ entity: bd.id, param: "volume" });
    await vi.waitFor(() => expect(currentView()).toBe("Mixer"));

    controls.restoreView(before);

    await vi.waitFor(() => expect(currentView()).toBe("Instrument"));
    await screen.findByRole("region", { name: "Synth voice" });
    expect(controlsAt({ entity: lead.id, param: "header" })[0]).toHaveClass("selected");
  });

  it("leaves the sequence view again when restoring after a clip's notes", async () => {
    const { project } = projectWithDevice();
    const [clip] = project.clips;
    const controls = await openProject(project);
    await goToView("Mixer");

    const before = controls.revealControl({ entity: clip.id, param: "notes" });
    await screen.findByRole("region", { name: "Sequence editor" });
    controls.restoreView(before);

    await vi.waitFor(() => expect(currentView()).toBe("Mixer"));
    expect(screen.queryByRole("region", { name: "Sequence editor" })).toBeNull();
  });
});

describe("control marks in the editor (UI-004)", () => {
  it("outlines only the addressed controls, in whichever view shows them", async () => {
    const { project } = projectWithDevice();
    const [bd, lead] = project.song.tracks;
    const controls = await openProject(project);
    await screen.findByTestId("arrangement-view-ready");

    controls.registry.setMark({ entity: bd.id, param: "volume" }, "previewed");
    controls.registry.setMark({ entity: "song", param: "tempo" }, "changed");
    await vi.waitFor(() =>
      expect(controlsAt({ entity: bd.id, param: "volume" })[0].dataset.controlMark).toBe(
        "previewed",
      ),
    );
    expect(controlsAt({ entity: "song", param: "tempo" })[0].dataset.controlMark).toBe(
      "changed",
    );
    expect(document.querySelectorAll("[data-control-mark]")).toHaveLength(2);

    // The mixer mounts its own volume fader, and it picks the mark up.
    await goToView("Mixer");
    const marked = [...document.querySelectorAll<HTMLElement>("[data-control-mark]")];
    expect(marked.map((element) => element.dataset.control).sort()).toEqual(
      [`${bd.id}:volume`, "song:tempo"].sort(),
    );
    expect(controlsAt({ entity: lead.id, param: "volume" })[0].dataset.controlMark).toBe(
      undefined,
    );
  });

  it("never touches the project, its history or a save", async () => {
    const { project, deviceId } = projectWithDevice();
    const [bd] = project.song.tracks;
    const [clip] = project.clips;
    const saveSong = vi.fn();
    const saveClip = vi.fn();
    const controls = await openProject(project);
    vi.spyOn(repository, "saveSong").mockImplementation(saveSong);
    vi.spyOn(repository, "saveClip").mockImplementation(saveClip);

    controls.registry.setMark({ entity: bd.id, param: "volume" }, "changed");
    const before = controls.revealControl({ entity: deviceId, param: "cutoff" });
    await expectFocusedIn({ entity: deviceId, param: "cutoff" });
    controls.revealControl({ entity: clip.id, param: "notes" });
    await screen.findByRole("region", { name: "Sequence editor" });
    controls.restoreView(before);
    controls.registry.clearMarks();
    await vi.waitFor(() => expect(currentView()).toBe("Arrangement"));

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(saveSong).not.toHaveBeenCalled();
    expect(saveClip).not.toHaveBeenCalled();
    const stored = await repository.loadProject(project.metadata.id);
    expect(stored.ok && stored.value.metadata.revision).toBe(project.metadata.revision);
  });
});
