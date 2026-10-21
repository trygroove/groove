import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import {
  addDevice,
  CommandHistory,
  type Gesture,
  type GestureOptions,
  type RawCommandInput,
  returnChain,
} from "../../commands";
import { createDevice } from "../../domain/devices";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory, type ReturnId } from "../../domain/ids";
import { MAX_RETURN_BUSES } from "../../domain/parse";
import { clickAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import { MAX_DISPLAY_NAME_LENGTH } from "../composition/displayNameLimit";
import Mixer from "./Mixer";
import { nextReturnName } from "./returnBuses";

afterEach(() => {
  cleanup();
});

/** The mixer against a real history, as `Mixer.test.tsx` drives it. */
function renderMixer(
  initial: Project = createSliceFixtureProject(),
  options: { optedOut?: boolean; noReturnSelection?: boolean } = {},
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
  if (options.optedOut) consent.optOut();
  const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
  analytics.setAccountType("anonymous");
  const [selectedReturnId, setSelectedReturnId] = createSignal<ReturnId | null>(null);

  render(() => (
    <Mixer
      project={project()}
      dispatch={dispatch}
      beginGesture={beginGesture}
      trackLevel={() => null}
      analytics={analytics}
      selectedTrackId={project().song.tracks[0]?.id ?? null}
      onSelectTrack={() => setSelectedReturnId(null)}
      selectedReturnId={selectedReturnId()}
      onSelectReturn={options.noReturnSelection ? undefined : setSelectedReturnId}
      onSelectMaster={() => setSelectedReturnId(null)}
    />
  ));

  /** Undoes and re-renders from the history's project. */
  const undo = () => {
    history.undo();
    setProject(history.project);
    flush();
  };
  return { history, project, transport, undo, selectedReturnId };
}

const returnStrips = () =>
  within(screen.getByRole("list", { name: "Returns" })).queryAllByRole("listitem");
const addReturn = () => clickAndFlush(screen.getByRole("button", { name: "Add return" }));

function drag(input: HTMLElement, values: readonly number[]): void {
  const range = input as HTMLInputElement;
  for (const value of values) {
    range.value = String(value);
    fireEvent.input(range);
    flush();
  }
  fireEvent.change(range);
  flush();
}

function firstUses(transport: ReturnType<typeof createRecordingTransport>, key: string) {
  return transport.events.filter(
    (event) => event.name === "feature_first_use" && event.params.feature === key,
  );
}

describe("nextReturnName", () => {
  it("names returns by the first free letter", () => {
    expect(nextReturnName([])).toBe("Return A");
    const project = createSliceFixtureProject();
    const bus = (name: string) => ({ ...project.song.master, name }) as never;
    expect(nextReturnName([bus("Return A"), bus("Verb")])).toBe("Return B");
  });
});

describe("Mixer returns (#386)", () => {
  it("adds a return after the tracks, before the master, as one undoable entry", () => {
    const { history } = renderMixer();
    expect(returnStrips()).toHaveLength(0);
    addReturn();

    expect(returnStrips()).toHaveLength(1);
    expect(history.project.song.returns.map((bus) => bus.name)).toEqual(["Return A"]);
    expect(history.entries).toHaveLength(1);
    const strip = returnStrips()[0];
    expect(within(strip).getByRole("textbox", { name: "Return name" })).toHaveValue(
      "Return A",
    );
    expect(
      within(strip).getByRole("slider", { name: "Volume for Return A" }),
    ).toBeTruthy();
    expect(within(strip).getByRole("slider", { name: "Pan for Return A" })).toBeTruthy();

    // The desk reads tracks, returns, master.
    const returns = screen.getByRole("list", { name: "Returns" });
    const master = screen.getByRole("button", { name: "Master" });
    expect(
      returns.compareDocumentPosition(master) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("stops adding at eight returns", () => {
    const { history } = renderMixer();
    for (let count = 0; count < MAX_RETURN_BUSES; count += 1) addReturn();
    expect(history.project.song.returns).toHaveLength(MAX_RETURN_BUSES);
    expect(screen.getByRole("button", { name: "Add return" })).toBeDisabled();
  });

  it("renames a return through one command", () => {
    const { history } = renderMixer();
    addReturn();
    const name = within(returnStrips()[0]).getByRole("textbox", { name: "Return name" });
    (name as HTMLInputElement).value = "Verb";
    fireEvent.change(name);
    flush();
    expect(history.project.song.returns[0].name).toBe("Verb");
    expect(history.entries).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Edit Verb" })).toBeTruthy();
  });

  it("Escape cancels a return name edit: the name comes back, nothing is committed", () => {
    const { history } = renderMixer();
    addReturn();
    const name = within(returnStrips()[0]).getByRole("textbox", {
      name: "Return name",
    }) as HTMLInputElement;
    name.focus();
    name.value = "escape retest";
    fireEvent.keyDown(name, { key: "Escape" });
    flush();
    expect(name).toHaveValue("Return A");
    expect(document.activeElement).not.toBe(name);
    // Leaving the field afterwards commits nothing.
    fireEvent.change(name);
    flush();
    expect(history.project.song.returns[0].name).toBe("Return A");
    expect(history.entries).toHaveLength(1);
  });

  it("caps the return name field at the longest name a return may have", () => {
    const { history } = renderMixer();
    addReturn();
    const name = within(returnStrips()[0]).getByRole("textbox", {
      name: "Return name",
    }) as HTMLInputElement;
    expect(name.maxLength).toBe(MAX_DISPLAY_NAME_LENGTH);
    const longest = "v".repeat(MAX_DISPLAY_NAME_LENGTH);
    name.value = longest;
    fireEvent.change(name);
    flush();
    expect(history.project.song.returns[0].name).toBe(longest);
  });

  it("edits a return's volume and pan, each drag as one entry", () => {
    const { history } = renderMixer();
    addReturn();
    const strip = returnStrips()[0];
    drag(
      within(strip).getByRole("slider", { name: "Volume for Return A" }),
      [0.6, 0.5, 0.4],
    );
    expect(history.entries).toHaveLength(2);
    expect(history.project.song.returns[0].mixer.volume).toBeLessThan(0);
    drag(within(strip).getByRole("slider", { name: "Pan for Return A" }), [0.2, -0.4]);
    expect(history.entries).toHaveLength(3);
    expect(history.project.song.returns[0].mixer.pan).toBe(-0.4);
  });

  it("selects a return from its strip, and marks it", () => {
    const { selectedReturnId, history } = renderMixer();
    addReturn();
    const edit = screen.getByRole("button", { name: "Edit Return A" });
    expect(edit).toHaveAttribute("aria-pressed", "false");
    clickAndFlush(edit);
    expect(selectedReturnId()).toBe(history.project.song.returns[0].id);
    expect(edit).toHaveAttribute("aria-pressed", "true");
    // While a return is selected, no track strip reads as selected.
    for (const button of screen.getAllByRole("button", { name: /^Edit / })) {
      if (button !== edit) expect(button).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("shows a selected return's chain in place of the master's (#1106)", () => {
    const { history, transport } = renderMixer();
    addReturn();
    clickAndFlush(screen.getByRole("button", { name: "Edit Return A" }));

    // The mixer's chain slot is the selected return's, not the master's.
    expect(screen.getByRole("region", { name: "Return effects" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Master effects" })).toBeNull();

    // And a device goes onto the return's chain, through the device commands.
    clickAndFlush(screen.getByRole("button", { name: "Add overdrive device" }));
    expect(history.project.song.returns[0].devices.map((d) => d.type)).toEqual([
      "overdrive",
    ]);
    expect(history.project.song.master.devices).toEqual([]);
    const added = transport.events.filter((e) => e.name === "device_added");
    expect(added).toHaveLength(1);
    expect(added[0].params).toMatchObject({ device_type: "overdrive", chain: "return" });
    expect(screen.getByRole("list", { name: "Return chain" })).toHaveTextContent(
      "Overdrive",
    );
  });

  it("goes back to the master's chain when the master is selected (#1106)", async () => {
    const { selectedReturnId } = renderMixer();
    addReturn();
    const master = screen.getByRole("button", { name: "Master" });
    const edit = screen.getByRole("button", { name: "Edit Return A" });
    clickAndFlush(edit);

    clickAndFlush(master);

    // Selecting the master lets go of the return.
    expect(selectedReturnId()).toBeNull();
    expect(screen.getByRole("region", { name: "Master effects" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Return effects" })).toBeNull();
    await Promise.resolve();
    expect(screen.getByRole("region", { name: "Master effects" })).toHaveFocus();
    expect(master).toHaveAttribute("aria-pressed", "true");
    expect(edit).toHaveAttribute("aria-pressed", "false");

    // And marks which chain the slot shows: the master's goes unpressed while
    // a return's is open.
    clickAndFlush(edit);
    expect(master).toHaveAttribute("aria-pressed", "false");
  });

  it("has no Edit control when there is nowhere to show a return", () => {
    renderMixer(undefined, { noReturnSelection: true });
    addReturn();
    expect(returnStrips()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Edit Return A" })).toBeNull();
  });

  it("names the chain a return carries", () => {
    const { history, project } = renderMixer();
    addReturn();
    history.execute(
      addDevice(
        returnChain(project().song.returns[0].id),
        createDevice(createSeededIdFactory("mixer-returns")("device"), "reverb", 0),
      ),
    );
    cleanup();
    renderMixer(history.project);
    expect(returnStrips()[0]).toHaveTextContent("Reverb");
  });
});

describe("Mixer sends (#386)", () => {
  it("sends a track to a return, and levels it as one gesture", () => {
    const { history, project } = renderMixer();
    addReturn();
    const track = project().song.tracks[0];
    clickAndFlush(screen.getByRole("button", { name: `Send ${track.name} to Return A` }));
    expect(history.project.song.tracks[0].sendConfig).toHaveLength(1);
    expect(history.entries).toHaveLength(2);

    const startRevision = history.project.metadata.revision;
    drag(
      screen.getByRole("slider", { name: `Send level from ${track.name} to Return A` }),
      [0.2, 0.4, 0.6],
    );
    expect(history.project.song.tracks[0].sendConfig[0].level).toBe(0.6);
    expect(history.project.metadata.revision).toBe(startRevision + 1);
    expect(history.entries).toHaveLength(3);
  });

  it("removes a send through its own button", () => {
    const { history, project } = renderMixer();
    addReturn();
    const track = project().song.tracks[0];
    clickAndFlush(screen.getByRole("button", { name: `Send ${track.name} to Return A` }));
    clickAndFlush(
      screen.getByRole("button", {
        name: `Remove send from ${track.name} to Return A`,
      }),
    );
    expect(history.project.song.tracks[0].sendConfig).toEqual([]);
    expect(
      screen.getByRole("button", { name: `Send ${track.name} to Return A` }),
    ).toBeTruthy();
  });

  it("removes a return with every send to it, and one undo restores both", () => {
    const { history, project, undo } = renderMixer();
    addReturn();
    const track = project().song.tracks[0];
    clickAndFlush(screen.getByRole("button", { name: `Send ${track.name} to Return A` }));
    drag(
      screen.getByRole("slider", { name: `Send level from ${track.name} to Return A` }),
      [0.5],
    );

    clickAndFlush(screen.getByRole("button", { name: "Delete Return A" }));
    expect(returnStrips()).toHaveLength(0);
    expect(history.project.song.tracks[0].sendConfig).toEqual([]);
    expect(screen.queryByRole("slider", { name: /^Send level/ })).toBeNull();

    undo();
    expect(returnStrips()).toHaveLength(1);
    expect(history.project.song.tracks[0].sendConfig[0].level).toBe(0.5);
    expect(
      screen.getByRole("slider", { name: `Send level from ${track.name} to Return A` }),
    ).toHaveValue("0.5");
  });

  it("logs send_return's first use once, however many sends and returns", () => {
    const { project, transport } = renderMixer();
    addReturn();
    addReturn();
    const track = project().song.tracks[0];
    clickAndFlush(screen.getByRole("button", { name: `Send ${track.name} to Return A` }));
    clickAndFlush(screen.getByRole("button", { name: `Send ${track.name} to Return B` }));
    drag(
      screen.getByRole("slider", { name: `Send level from ${track.name} to Return A` }),
      [0.5],
    );
    expect(firstUses(transport, "send_return")).toHaveLength(1);
  });

  it("logs send_return only when a send is used, not for a return alone", () => {
    const { transport } = renderMixer();
    addReturn();
    const strip = returnStrips()[0];
    drag(within(strip).getByRole("slider", { name: "Volume for Return A" }), [0.5]);
    drag(within(strip).getByRole("slider", { name: "Pan for Return A" }), [0.3]);
    expect(firstUses(transport, "send_return")).toHaveLength(0);
  });

  it("logs send_return when a send is added", () => {
    const { project, transport } = renderMixer();
    addReturn();
    const track = project().song.tracks[0];
    clickAndFlush(screen.getByRole("button", { name: `Send ${track.name} to Return A` }));
    expect(firstUses(transport, "send_return")).toHaveLength(1);
  });

  it("logs nothing once analytics is turned off, and the mixer still works", () => {
    const { history, project, transport } = renderMixer(undefined, { optedOut: true });
    addReturn();
    const track = project().song.tracks[0];
    clickAndFlush(screen.getByRole("button", { name: `Send ${track.name} to Return A` }));
    expect(history.project.song.returns).toHaveLength(1);
    expect(history.project.song.tracks[0].sendConfig).toHaveLength(1);
    expect(transport.events).toHaveLength(0);
  });
});
