import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { addDevice, CommandHistory, insertChain } from "../commands";
import { createDevice } from "../domain/devices";
import { createPianoRollFixtureProject } from "../domain/fixtures";
import { createSeededIdFactory, type TrackId } from "../domain/ids";
import { MAX_TRACK_INSERTS } from "../domain/parse";
import { moveTo } from "../instrument/panelTesting";
import { useShortcutScope } from "../shortcuts/useShortcutScope";
import { clickAndFlush, fireAndFlush } from "../testing/events";
import { memoryStorage } from "../testing/storage";
import { pointer } from "../testing/trackDrag";
import DeviceChainPanel from "./DeviceChainPanel";
import { dragCard, LOWER, overCard, stubChainLayout, UPPER } from "./deviceChainTesting";

afterEach(() => cleanup());

function recordingAnalytics(options = { allowed: true }) {
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  if (!options.allowed) consent.optOut();
  const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
  analytics.setAccountType("anonymous");
  return { transport, analytics };
}

/** The panel over a real history, showing the fixture's first track. */
function renderPanel(
  options: { preload?: number; allowed?: boolean; onTrackDelete?: () => void } = {},
) {
  const history = new CommandHistory(createPianoRollFixtureProject());
  const trackId = history.project.song.tracks[0].id;
  const ids = createSeededIdFactory("device-chain-panel");
  for (let order = 0; order < (options.preload ?? 0); order += 1) {
    history.execute(
      addDevice(insertChain(trackId), createDevice(ids("device"), "filter", order)),
    );
  }
  const [project, setProject] = createSignal(history.project);
  history.subscribe(() => setProject(history.project));
  const { transport, analytics } = recordingAnalytics({
    allowed: options.allowed ?? true,
  });
  render(() => (
    <EditorScope onTrackDelete={options.onTrackDelete}>
      <DeviceChainPanel
        track={project().song.tracks[0]}
        dispatch={(commands) => history.execute(commands)}
        beginGesture={(gesture) => history.beginGesture(gesture)}
        analytics={analytics}
        ids={ids}
      />
    </EditorScope>
  ));
  const panel = () => within(screen.getByRole("region", { name: "Device chain" }));
  const items = () =>
    within(panel().getByRole("list", { name: "Device chain" })).queryAllByRole(
      "listitem",
    );
  return { history, project, transport, panel, items };
}

/**
 * Stands in for the editor's scope around the chain: Delete and Mod+D there
 * act on the selected track, as `useEditorShortcuts` does, so a key the chain
 * does not keep reaches it.
 */
function EditorScope(props: { onTrackDelete?: () => void; children: JSX.Element }) {
  useShortcutScope({
    handlers: () => ({
      "edit.delete": { run: () => props.onTrackDelete?.() },
      "edit.duplicate": { run: () => props.onTrackDelete?.() },
    }),
    contexts: () => ["editor", "arrangement"],
  });
  return props.children;
}

function addFromPanel(panel: ReturnType<typeof renderPanel>["panel"], label: string) {
  clickAndFlush(
    panel().getByRole("button", { name: `Add ${label.toLowerCase()} device` }),
  );
}

describe("DeviceChainPanel", () => {
  it("shows an empty track chain as an empty list, with no note (#447)", () => {
    const { items } = renderPanel();
    expect(items()).toHaveLength(0);
    expect(screen.queryByText(/no devices/i)).toBeNull();
  });

  it("offers one add button per registered type, and appends each in order as one entry", () => {
    const { history, panel, items } = renderPanel();
    const addButtons = () =>
      within(panel().getByRole("group", { name: "Add device" })).getAllByRole("button");
    // At the end of the chain, where the next device goes — as the add-track
    // buttons sit below the last track.
    expect(
      panel()
        .getByRole("list", { name: "Device chain" })
        .compareDocumentPosition(panel().getByRole("group", { name: "Add device" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const offered = addButtons().map((button) => button.textContent);
    expect(offered).toEqual([
      "Filter",
      "Overdrive",
      "Saturator",
      "Compressor",
      "Delay",
      "Reverb",
      "EQ",
      "Limiter",
    ]);
    addFromPanel(panel, "Filter");
    // The buttons stay where they are, after the chain, ready for the next one.
    expect(addButtons()).toHaveLength(8);

    const entries = history.entries.length;
    addFromPanel(panel, "Delay");
    expect(items().map((item) => within(item).getByRole("heading").textContent)).toEqual([
      "Filter",
      "Delay",
    ]);
    expect(history.entries.length).toBe(entries + 1);
    fireAndFlush(() => history.undo());
    expect(items()).toHaveLength(1);
  });

  it("logs device_added once per add, and device_chain's first use once", () => {
    const { transport, panel } = renderPanel();
    addFromPanel(panel, "Filter");
    addFromPanel(panel, "Reverb");
    expect(transport.named("device_added").map((event) => event.params)).toEqual([
      expect.objectContaining({ device_type: "filter", chain: "insert" }),
      expect.objectContaining({ device_type: "reverb", chain: "insert" }),
    ]);
    expect(
      transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "device_chain"),
    ).toHaveLength(1);
  });

  it("logs the EQ's own first use once, alongside device_added (LOOP-022)", () => {
    const { transport, panel } = renderPanel();
    addFromPanel(panel, "Filter");
    expect(
      transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "eq_device"),
    ).toHaveLength(0);
    addFromPanel(panel, "EQ");
    addFromPanel(panel, "EQ");
    expect(transport.named("device_added").map((event) => event.params)).toEqual([
      expect.objectContaining({ device_type: "filter", chain: "insert" }),
      expect.objectContaining({ device_type: "eq", chain: "insert" }),
      expect.objectContaining({ device_type: "eq", chain: "insert" }),
    ]);
    expect(
      transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "eq_device"),
    ).toHaveLength(1);
  });

  it("logs the Limiter's own first use once, alongside device_added (#937)", () => {
    const { transport, panel } = renderPanel();
    addFromPanel(panel, "Limiter");
    addFromPanel(panel, "Limiter");
    expect(transport.named("device_added").map((event) => event.params)).toEqual([
      expect.objectContaining({ device_type: "limiter", chain: "insert" }),
      expect.objectContaining({ device_type: "limiter", chain: "insert" }),
    ]);
    expect(
      transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "limiter_device"),
    ).toHaveLength(1);
  });

  it("changes nothing but the telemetry when analytics is off", () => {
    const { transport, panel, items } = renderPanel({ allowed: false });
    addFromPanel(panel, "Compressor");
    expect(items()).toHaveLength(1);
    expect(transport.events).toEqual([]);
  });

  it(`stops adding and duplicating at ${MAX_TRACK_INSERTS} inserts`, () => {
    const { panel, items } = renderPanel({ preload: MAX_TRACK_INSERTS - 1 });
    const addButtons = () =>
      within(panel().getByRole("group", { name: "Add device" })).getAllByRole("button");
    for (const button of addButtons()) expect(button).toBeEnabled();
    addFromPanel(panel, "Delay");
    expect(items()).toHaveLength(MAX_TRACK_INSERTS);
    for (const button of addButtons()) expect(button).toBeDisabled();
    expect(panel().getByText(/holds up to 16 devices/)).toBeInTheDocument();
    for (const item of items()) {
      expect(within(item).getByRole("button", { name: /^Duplicate/ })).toBeDisabled();
    }
  });

  it("moves a device by dragging its header onto another, as one entry", async () => {
    const { history, panel, items } = renderPanel();
    addFromPanel(panel, "Overdrive");
    addFromPanel(panel, "Reverb");
    const names = () =>
      items().map((item) => within(item).getByRole("heading").textContent);
    const entries = history.entries.length;
    const [overdrive, reverb] = items();
    await dragCard(reverb.querySelector("header") as Element, overdrive);
    expect(names()).toEqual(["Reverb", "Overdrive"]);
    expect(history.entries.length).toBe(entries + 1);
    fireAndFlush(() => history.undo());
    expect(names()).toEqual(["Overdrive", "Reverb"]);
  });

  it("previews the new order while a card is held, and Escape puts it back", async () => {
    const { history, panel, items } = renderPanel();
    addFromPanel(panel, "Overdrive");
    addFromPanel(panel, "Reverb");
    const [overdrive, reverb] = items();
    const shown = () => [overdrive.style.order, reverb.style.order];
    const entries = history.entries.length;
    stubChainLayout();

    fireAndFlush(() => {
      fireEvent(reverb.querySelector("header") as Element, pointer("pointerdown", 1, 1));
      fireEvent(window, pointer("pointermove", 50, overCard(overdrive, UPPER)));
    });
    // Reverb shows first, the chain it would become; nothing is committed yet.
    expect(shown()).toEqual(["1", "0"]);
    expect(reverb).toHaveClass("dragging");
    expect(history.entries.length).toBe(entries);
    // The card is picked up: a copy follows the pointer and is not a chain item.
    const copy = document.querySelector<HTMLElement>(".drag-lift");
    expect(copy?.textContent).toContain("Reverb");
    expect(items()).toHaveLength(2);

    fireAndFlush(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(document.querySelector(".drag-lift")).toBeNull();
    expect(shown()).toEqual(["0", "1"]);
    expect(reverb).not.toHaveClass("dragging");
    fireAndFlush(() => fireEvent(window, pointer("pointerup", 50, 0)));
    expect(shown()).toEqual(["0", "1"]);
    expect(history.entries.length).toBe(entries);
    // The release after Escape is not a click on the card.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("offers every slot while held, the one it started in included", async () => {
    const { history, panel, items } = renderPanel();
    addFromPanel(panel, "Filter");
    addFromPanel(panel, "Delay");
    addFromPanel(panel, "Reverb");
    const [filter, delay, reverb] = items();
    // The order each card shows in, read in chain order: Filter, Delay, Reverb.
    const shown = () => [filter, delay, reverb].map((item) => item.style.order);
    const entries = history.entries.length;
    stubChainLayout();
    const over = (y: number) =>
      fireAndFlush(() => fireEvent(window, pointer("pointermove", 50, y)));

    fireAndFlush(() =>
      fireEvent(delay.querySelector("header") as Element, pointer("pointerdown", 1, 1)),
    );
    over(overCard(filter, UPPER)); // above Filter: Delay, Filter, Reverb
    expect(shown()).toEqual(["1", "0", "2"]);
    over(overCard(reverb, LOWER)); // below Reverb: Filter, Reverb, Delay
    expect(shown()).toEqual(["0", "2", "1"]);
    over(overCard(reverb, UPPER)); // back where it started: Filter, Delay, Reverb
    expect(shown()).toEqual(["0", "1", "2"]);

    // Dropping in the slot it started in moves nothing and records nothing.
    fireAndFlush(() =>
      fireEvent(window, pointer("pointerup", 50, overCard(reverb, UPPER))),
    );
    expect(items().map((item) => within(item).getByRole("heading").textContent)).toEqual([
      "Filter",
      "Delay",
      "Reverb",
    ]);
    expect(history.entries.length).toBe(entries);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not start a drag from one of the card's controls", async () => {
    const { panel, items } = renderPanel();
    addFromPanel(panel, "Filter");
    addFromPanel(panel, "Delay");
    const [filter, delay] = items();
    await dragCard(within(delay).getAllByRole("slider")[0], filter);
    expect(items().map((item) => within(item).getByRole("heading").textContent)).toEqual([
      "Filter",
      "Delay",
    ]);
  });

  it("does not start a drag from a device's well", async () => {
    const { panel, items } = renderPanel();
    addFromPanel(panel, "Filter");
    addFromPanel(panel, "Overdrive");
    const [filter, overdrive] = items();
    await dragCard(overdrive.querySelector(".drag-surface") as Element, filter);
    expect(items().map((item) => within(item).getByRole("heading").textContent)).toEqual([
      "Filter",
      "Overdrive",
    ]);
    expect(overdrive).not.toHaveClass("dragging");
  });

  it("moves the device whose name has focus with Alt+Up and Alt+Down", () => {
    const { history, panel, items } = renderPanel();
    addFromPanel(panel, "Overdrive");
    addFromPanel(panel, "Reverb");
    const names = () =>
      items().map((item) => within(item).getByRole("heading").textContent);
    const grip = (name: string) => panel().getByRole("button", { name });
    const press = (key: string) =>
      fireAndFlush(() =>
        fireEvent.keyDown(document.activeElement ?? document.body, { key, altKey: true }),
      );

    fireAndFlush(() => grip("Reverb").focus());
    const entries = history.entries.length;
    press("ArrowUp");
    expect(names()).toEqual(["Reverb", "Overdrive"]);
    expect(history.entries.length).toBe(entries + 1);
    // Already first: nothing to do, and no entry.
    press("ArrowUp");
    expect(history.entries.length).toBe(entries + 1);
    press("ArrowDown");
    expect(names()).toEqual(["Overdrive", "Reverb"]);
  });

  // GRV-186 QA: Delete on a focused device header fell through to the editor
  // and deleted the whole track.
  it("removes and duplicates the device whose name has focus, never the track", async () => {
    let trackKeys = 0;
    const { history, panel, items } = renderPanel({
      onTrackDelete: () => {
        trackKeys += 1;
      },
    });
    addFromPanel(panel, "Filter");
    addFromPanel(panel, "Reverb");
    const names = () =>
      items().map((item) => within(item).getByRole("heading").textContent);
    const grip = (name: string) => panel().getByRole("button", { name });
    const press = (init: KeyboardEventInit) =>
      fireAndFlush(() =>
        fireEvent.keyDown(document.activeElement ?? document.body, init),
      );

    fireAndFlush(() => grip("Reverb").focus());
    const entries = history.entries.length;
    press({ key: "d", ctrlKey: true });
    expect(names()).toEqual(["Filter", "Reverb", "Reverb"]);
    expect(history.entries.length).toBe(entries + 1);

    press({ key: "Delete" });
    expect(names()).toEqual(["Filter", "Reverb"]);
    // Focus moves to the header that took the removed device's place.
    await Promise.resolve();
    fireAndFlush(() => undefined);
    expect(document.activeElement).toBe(grip("Reverb"));
    press({ key: "Backspace" });
    expect(names()).toEqual(["Filter"]);
    expect(trackKeys).toBe(0);

    // Off the chain, the keys belong to the editor again.
    fireAndFlush(() => (document.activeElement as HTMLElement | null)?.blur());
    press({ key: "Delete" });
    expect(trackKeys).toBe(1);
    expect(names()).toEqual(["Filter"]);
  });

  it("keeps a slider in place through a drag, committing it as one entry", () => {
    const { history, panel, items, project } = renderPanel();
    addFromPanel(panel, "Filter");
    const entries = history.entries.length;
    const cutoff = within(items()[0]).getByRole("slider", {
      name: "Cutoff",
    }) as HTMLInputElement;
    moveTo(cutoff, "4000");
    moveTo(cutoff, "800");
    // The same element the pointer started on: the card was not rebuilt.
    expect(within(items()[0]).getByRole("slider", { name: "Cutoff" })).toBe(cutoff);
    fireAndFlush(() => cutoff.dispatchEvent(new Event("change", { bubbles: true })));
    expect(project().song.tracks[0].devices[0].parameters.cutoff).toBe(800);
    expect(history.entries.length).toBe(entries + 1);
  });

  it("reports a refused edit as device_edit_failed, naming nothing", () => {
    // The panel shows a track the history's project does not hold, so the
    // command layer genuinely refuses the add.
    const history = new CommandHistory(createPianoRollFixtureProject());
    const stranger = { ...history.project.song.tracks[0], id: "trk_absent" as TrackId };
    const { transport, analytics } = recordingAnalytics();
    render(() => (
      <DeviceChainPanel
        track={stranger}
        dispatch={(commands) => history.execute(commands)}
        beginGesture={(gesture) => history.beginGesture(gesture)}
        analytics={analytics}
        ids={createSeededIdFactory("device-chain-refused")}
      />
    ));
    clickAndFlush(screen.getByRole("button", { name: "Add filter device" }));

    const failures = transport.events.filter((e) => e.name === "device_edit_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].params).toMatchObject({
      operation: "add",
      error_code: "internal",
    });
    expect(JSON.stringify(failures[0].params)).not.toMatch(/trk_|dev_|prj_/);
    expect(transport.events.filter((e) => e.name === "device_added")).toHaveLength(0);
  });
});

describe("DeviceChainPanel heading (#447)", () => {
  it("shows no heading on a track's chain; the master's keeps its own", () => {
    const { panel } = renderPanel();
    expect(panel().queryByRole("heading")).toBeNull();
  });
});
