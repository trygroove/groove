import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { CommandHistory } from "../../commands";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { MAX_TRACK_INSERTS } from "../../domain/parse";
import { moveTo } from "../../instrument/panelTesting";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import { dragCard } from "../devices/deviceChainTesting";
import MasterPanel from "./MasterPanel";

afterEach(() => cleanup());

/** The master panel over a real history, so every edit is a real command. */
function renderPanel() {
  const history = new CommandHistory(createPianoRollFixtureProject());
  const [project, setProject] = createSignal(history.project);
  history.subscribe(() => setProject(history.project));
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  const ids = createSeededIdFactory("master-panel");
  render(() => (
    <MasterPanel
      project={project()}
      dispatch={(commands) => history.execute(commands)}
      beginGesture={(gesture) => history.beginGesture(gesture)}
      analytics={analytics}
      ids={ids}
    />
  ));
  const panel = () => within(screen.getByRole("region", { name: "Master effects" }));
  const items = () =>
    within(panel().getByRole("list", { name: "Master chain" })).queryAllByRole(
      "listitem",
    );
  const names = () =>
    items().map((item) => within(item).getByRole("heading").textContent);
  const add = (label: string) =>
    clickAndFlush(
      panel().getByRole("button", { name: `Add ${label.toLowerCase()} device` }),
    );
  const master = () => project().song.master.devices;
  return { history, transport, panel, items, names, add, master };
}

/**
 * The master's chain is the track chain's component (#241) addressed to the
 * master, so what is proved here is the address and the names — the chain's
 * own behaviour is `DeviceChainPanel.test.tsx`'s.
 */
describe("MasterPanel", () => {
  it("names the master's effects and its chain, empty until something is added", () => {
    const { panel, items } = renderPanel();
    expect(panel().getByRole("heading", { name: "Master" })).toBeInTheDocument();
    expect(items()).toHaveLength(0);
    expect(panel().getByText(/Nothing on the master yet/)).toBeInTheDocument();
  });

  it("adds a new device before a Limiter at the end, so the Limiter stays last (#937)", () => {
    const { add, names, master } = renderPanel();
    add("Limiter");
    add("Saturator");
    add("Compressor");
    expect(names()).toEqual(["Saturator", "Compressor", "Limiter"]);
    expect(master().map((device) => [device.type, device.order])).toEqual(
      expect.arrayContaining([
        ["saturator", 0],
        ["compressor", 1],
        ["limiter", 2],
      ]),
    );
  });

  it("adds to the master, not a track, as one undoable entry", () => {
    const { history, transport, add, names, master } = renderPanel();
    const tracksBefore = history.project.song.tracks;
    add("Overdrive");
    expect(master().map((device) => device.type)).toEqual(["overdrive"]);
    expect(history.project.song.tracks).toBe(tracksBefore);
    expect(history.entries).toHaveLength(1);
    const added = transport.events.filter((e) => e.name === "device_added");
    expect(added[0].params).toMatchObject({ device_type: "overdrive", chain: "master" });

    fireAndFlush(() => history.undo());
    expect(names()).toEqual([]);
    fireAndFlush(() => history.redo());
    expect(names()).toEqual(["Overdrive"]);
  });

  it("reorders the master by dragging a card, as one entry", async () => {
    const { history, add, items, names } = renderPanel();
    add("Overdrive");
    add("Reverb");
    const entries = history.entries.length;
    const [overdrive, reverb] = items();
    await dragCard(reverb.querySelector("header") as Element, overdrive);
    expect(names()).toEqual(["Reverb", "Overdrive"]);
    expect(history.entries.length).toBe(entries + 1);
  });

  it("does not reorder the master when a device's well is dragged", async () => {
    const { add, items, names } = renderPanel();
    add("Filter");
    add("Overdrive");
    const [filter, overdrive] = items();
    await dragCard(overdrive.querySelector(".drag-surface") as Element, filter);
    expect(names()).toEqual(["Filter", "Overdrive"]);
  });

  it("writes a master device's parameter through masterDevice, one entry per drag", () => {
    const { history, add, items, master } = renderPanel();
    add("Overdrive");
    const entries = history.entries.length;
    const drive = within(items()[0]).getByRole("slider", {
      name: "Drive",
    }) as HTMLInputElement;
    moveTo(drive, "0.9");
    fireAndFlush(() => drive.dispatchEvent(new Event("change", { bubbles: true })));
    expect(master()[0].parameters.drive).toBe(0.9);
    expect(history.entries.length).toBe(entries + 1);
  });

  it("does not stop at a track's insert limit: the master is unbounded", () => {
    const { add, items, panel } = renderPanel();
    for (let count = 0; count <= MAX_TRACK_INSERTS; count += 1) add("Filter");
    expect(items()).toHaveLength(MAX_TRACK_INSERTS + 1);
    expect(panel().getByRole("button", { name: "Add filter device" })).toBeEnabled();
  });
});
