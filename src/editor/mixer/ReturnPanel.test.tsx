import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { addReturn, addSend, CommandHistory } from "../../commands";
import type { Project } from "../../domain/entities";
import {
  createFactoryContext,
  createReturnBus,
  createSend,
} from "../../domain/factories";
import { createReferenceProject } from "../../domain/fixtures";
import { createSeededIdFactory, type ReturnId, type TrackId } from "../../domain/ids";
import { moveTo } from "../../instrument/panelTesting";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import EditorInstrument from "../instrument/EditorInstrument";
import ReturnPanel from "./ReturnPanel";

afterEach(() => cleanup());

/** A project with one return, "Verb", that the first track sends to. */
function withReturn(): { history: CommandHistory; returnId: ReturnId } {
  const history = new CommandHistory(createReferenceProject());
  const bus = createReturnBus(
    createFactoryContext({ ids: createSeededIdFactory("return-panel") }),
    { name: "Verb", order: history.project.song.returns.length },
  );
  history.execute(addReturn(bus));
  history.execute(addSend(history.project.song.tracks[0].id, createSend(bus.id, 0.5)));
  return { history, returnId: bus.id };
}

function analyticsFor(options: { allowed: boolean }) {
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  if (!options.allowed) consent.optOut();
  const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
  analytics.setAccountType("anonymous");
  return { transport, analytics };
}

function renderPanel(options: { allowed: boolean } = { allowed: true }) {
  const { history, returnId } = withReturn();
  const [project, setProject] = createSignal<Project>(history.project);
  history.subscribe(() => setProject(history.project));
  const { transport, analytics } = analyticsFor(options);
  const bus = () => project().song.returns.find((candidate) => candidate.id === returnId);
  const ids = createSeededIdFactory("return-panel-devices");
  render(() => (
    <ReturnPanel
      project={project()}
      returnBus={bus() ?? project().song.returns[0]}
      dispatch={(commands) => history.execute(commands)}
      beginGesture={(gesture) => history.beginGesture(gesture)}
      analytics={analytics}
      ids={ids}
    />
  ));
  const panel = () => within(screen.getByRole("region", { name: "Return effects" }));
  const items = () =>
    within(panel().getByRole("list", { name: "Return chain" })).queryAllByRole(
      "listitem",
    );
  const add = (label: string) =>
    clickAndFlush(
      panel().getByRole("button", { name: `Add ${label.toLowerCase()} device` }),
    );
  return { history, project, returnId, transport, panel, items, add };
}

describe("ReturnPanel (#386)", () => {
  it("names the return and how many tracks feed it", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Verb" })).toBeTruthy();
    expect(screen.getByText("1 track sends to it")).toBeTruthy();
  });

  it("adds, duplicates, bypasses, resets and removes on the return's chain", () => {
    const { history, returnId, items, add, panel } = renderPanel();
    const chain = () =>
      history.project.song.returns.find((bus) => bus.id === returnId)?.devices ?? [];

    add("Reverb");
    add("Delay");
    expect(chain().map((device) => device.type)).toEqual(["reverb", "delay"]);
    expect(items()).toHaveLength(2);

    clickAndFlush(panel().getAllByRole("button", { name: /^Duplicate / })[0]);
    expect(chain().map((device) => device.type)).toEqual(["reverb", "reverb", "delay"]);

    clickAndFlush(panel().getAllByRole("button", { name: /^Bypass / })[2]);
    expect(chain()[2].bypassed).toBe(true);

    clickAndFlush(panel().getAllByRole("button", { name: /^Reset / })[0]);
    clickAndFlush(panel().getAllByRole("button", { name: /^Remove / })[1]);
    expect(chain().map((device) => device.type)).toEqual(["reverb", "delay"]);

    // No track's chain moved: every edit went to the return.
    for (const track of history.project.song.tracks) {
      expect(track.devices).toEqual(
        createReferenceProject().song.tracks.find((t) => t.id === track.id)?.devices,
      );
    }
  });

  it("writes a return device's parameter through returnDevice, one entry per drag", () => {
    const { history, returnId, add, items } = renderPanel();
    add("Reverb");
    const entries = history.entries.length;
    const size = within(items()[0]).getByRole("slider", {
      name: "Size",
    }) as HTMLInputElement;
    moveTo(size, "0.7");
    fireAndFlush(() => size.dispatchEvent(new Event("change", { bubbles: true })));
    const bus = history.project.song.returns.find(
      (candidate) => candidate.id === returnId,
    );
    expect(bus?.devices[0].parameters.size).toBe(0.7);
    expect(history.entries.length).toBe(entries + 1);
  });

  it("logs device_added with the return chain", () => {
    const { transport, add } = renderPanel();
    add("Reverb");
    expect(transport.named("device_added").map((event) => event.params)).toEqual([
      expect.objectContaining({ device_type: "reverb", chain: "return" }),
    ]);
  });

  it("changes nothing but the telemetry when analytics is off", () => {
    const { transport, add, items } = renderPanel({ allowed: false });
    add("Reverb");
    expect(items()).toHaveLength(1);
    expect(transport.events).toEqual([]);
  });
});

describe("the Instrument view's return mode (#386)", () => {
  function renderView() {
    const { history, returnId } = withReturn();
    const [project, setProject] = createSignal<Project>(history.project);
    history.subscribe(() => setProject(history.project));
    const [selectedReturn, setSelectedReturn] = createSignal<ReturnId | null>(returnId);
    const [selected, setSelected] = createSignal<TrackId>(project().song.tracks[0].id);
    const track = () =>
      project().song.tracks.find((candidate) => candidate.id === selected()) ?? null;
    const bus = () =>
      project().song.returns.find((candidate) => candidate.id === selectedReturn()) ??
      null;
    render(() => (
      <EditorInstrument
        project={project()}
        track={track()}
        returnBus={bus()}
        drumTrack={null}
        sampleAssets={[]}
        instrument={track()?.instrument ?? null}
        instrumentTrackId={track()?.id ?? null}
        sampleName={null}
        loadSample={() => {}}
        audition={() => {}}
        auditionPad={() => {}}
        onBrowse={() => {}}
        onSelectTrack={(id) => {
          setSelectedReturn(null);
          setSelected(id);
        }}
        dispatch={(commands) => history.execute(commands)}
        beginGesture={(gesture) => history.beginGesture(gesture)}
      />
    ));
    return { history };
  }

  it("shows the return's chain and no instrument, and leaves for a track", () => {
    const { history } = renderView();
    expect(screen.getByRole("region", { name: "Return effects" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Instrument" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Device chain" })).toBeNull();
    const rail = within(screen.getByRole("list", { name: "Tracks" }));
    for (const edit of rail.getAllByRole("button", { name: /^Edit / })) {
      expect(edit).toHaveAttribute("aria-pressed", "false");
    }

    clickAndFlush(
      rail.getByRole("button", { name: `Edit ${history.project.song.tracks[0].name}` }),
    );
    expect(screen.queryByRole("region", { name: "Return effects" })).toBeNull();
    expect(screen.getByRole("region", { name: "Device chain" })).toBeTruthy();
  });
});
