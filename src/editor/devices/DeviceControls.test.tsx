import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { addDevice, CommandHistory, insertChain, setParameter } from "../../commands";
import { createDevice, type DeviceTypeId, deviceParameters } from "../../domain/devices";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { defineParameter } from "../../domain/parameters";
import { moveTo } from "../../instrument/panelTesting";
import { createManualClock } from "../../shared/clock";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import DeviceControls from "./DeviceControls";
import { deviceChoices } from "./deviceControlModel";

afterEach(() => cleanup());

/**
 * One track carrying the given devices, over a real command history, so every
 * control's value comes back out of the project it edits.
 */
function renderDevices(types: readonly DeviceTypeId[]) {
  const clock = createManualClock(1_000_000);
  const history = new CommandHistory(createPianoRollFixtureProject(), { clock });
  const trackId = history.project.song.tracks[0].id;
  const ids = createSeededIdFactory("device-controls");
  types.forEach((type, order) => {
    history.execute(
      addDevice(insertChain(trackId), createDevice(ids("device"), type, order)),
    );
  });
  const [project, setProject] = createSignal(history.project);
  history.subscribe(() => setProject(history.project));
  const devices = () => project().song.tracks[0].devices;
  render(() => (
    <ul>
      {types.map((_, index) => (
        <li data-testid={`device-${index}`}>
          <DeviceControls
            chain={insertChain(trackId)}
            device={devices()[index]}
            dispatch={(commands) => history.execute(commands)}
            beginGesture={(options) => history.beginGesture(options)}
          />
        </li>
      ))}
    </ul>
  ));
  return {
    history,
    clock,
    devices,
    device: (index: number) => screen.getByTestId(`device-${index}`),
  };
}

describe("DeviceControls", () => {
  it("shows a filter's own controls, from its definitions, not a preset list", () => {
    const { device } = renderDevices(["filter"]);
    const filter = within(device(0));
    expect(filter.getByRole("slider", { name: "Cutoff" })).toHaveValue("2000");
    expect(filter.getByRole("slider", { name: "Resonance" })).toBeInTheDocument();
    expect(filter.getByRole("slider", { name: "Dry/Wet" })).toBeInTheDocument();
    const mode = filter.getByRole("group", { name: "Mode" });
    expect(
      within(mode)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.textContent),
    ).toEqual(["Low pass", "High pass", "Band pass"]);
    expect(filter.queryByRole("combobox")).toBeNull();
  });

  it("gives every device type a control per parameter", () => {
    const types: DeviceTypeId[] = [
      "overdrive",
      "saturator",
      "compressor",
      "delay",
      "reverb",
    ];
    const { device } = renderDevices(types);
    types.forEach((type, index) => {
      const labels = deviceParameters(type).map((definition) => definition.label);
      for (const label of labels) {
        const scope = within(device(index));
        expect(
          scope.queryByRole("slider", { name: label }) ??
            scope.queryByRole("group", { name: label }),
        ).not.toBeNull();
      }
    });
  });

  it("commits a whole slider drag as one history entry and one revision", () => {
    const { history, devices, device } = renderDevices(["filter"]);
    const entries = history.entries.length;
    const revision = history.project.metadata.revision;
    const cutoff = within(device(0)).getByRole("slider", {
      name: "Cutoff",
    }) as HTMLInputElement;

    moveTo(cutoff, "3000");
    moveTo(cutoff, "2000");
    moveTo(cutoff, "800");
    // The control follows the pointer before release.
    expect(cutoff).toHaveValue("800");
    fireAndFlush(() => fireEvent.change(cutoff, { target: { value: "800" } }));

    expect(devices()[0].parameters.cutoff).toBe(800);
    expect(history.entries.length).toBe(entries + 1);
    expect(history.project.metadata.revision).toBe(revision + 1);

    fireAndFlush(() => history.undo());
    expect(devices()[0].parameters.cutoff).toBe(2000);
    expect(cutoff).toHaveValue("2000");
  });

  // GRV-63: a browser ends a drag with `pointerup` *and* `change`. Both used
  // to commit, and the second, finding no gesture open, landed the value again
  // as its own entry, so every drag took two undos to take back.
  it("commits a drag the browser ends with pointerup then change as one undo step", () => {
    const { history, devices, device } = renderDevices(["delay"]);
    const entries = history.entries.length;
    const feedback = within(device(0)).getByRole("slider", {
      name: "Feedback",
    }) as HTMLInputElement;

    fireAndFlush(() => fireEvent.pointerDown(feedback));
    moveTo(feedback, "0.5");
    moveTo(feedback, "0.6");
    moveTo(feedback, "0.7");
    // Chromium's order on release: pointerup, then change.
    fireAndFlush(() => fireEvent.pointerUp(feedback));
    fireAndFlush(() => fireEvent.change(feedback, { target: { value: "0.7" } }));

    expect(devices()[0].parameters.feedback).toBe(0.7);
    expect(history.entries.length).toBe(entries + 1);
    expect(history.undoSummary).toBe("Set Feedback");

    fireAndFlush(() => history.undo());
    expect(devices()[0].parameters.feedback).toBe(0.4);
  });

  it("adds no undo step for a click that does not move the slider", () => {
    const { history, device } = renderDevices(["delay"]);
    const entries = history.entries.length;
    const feedback = within(device(0)).getByRole("slider", { name: "Feedback" });

    fireAndFlush(() => fireEvent.pointerDown(feedback));
    fireAndFlush(() => fireEvent.pointerUp(feedback));

    expect(history.entries.length).toBe(entries);
  });

  it("makes a quick run of arrow-key presses one undo step", () => {
    const { history, clock, devices, device } = renderDevices(["delay"]);
    const entries = history.entries.length;
    const feedback = within(device(0)).getByRole("slider", {
      name: "Feedback",
    }) as HTMLInputElement;

    // An arrow key fires `input` then `change`, with no pointer involved.
    const press = (value: string) => {
      moveTo(feedback, value);
      fireAndFlush(() => fireEvent.change(feedback, { target: { value } }));
    };
    for (const value of ["0.41", "0.42", "0.43", "0.44"]) {
      press(value);
      clock.advance(150);
    }
    expect(devices()[0].parameters.feedback).toBe(0.44);
    expect(history.entries.length).toBe(entries + 1);

    // A pause ends the run: the next press is a step of its own.
    clock.advance(5_000);
    press("0.45");
    expect(history.entries.length).toBe(entries + 2);

    fireAndFlush(() => history.undo());
    expect(devices()[0].parameters.feedback).toBe(0.44);
    fireAndFlush(() => history.undo());
    expect(devices()[0].parameters.feedback).toBe(0.4);
  });

  it("names a mode change by the choice the user sees", () => {
    const { history, device } = renderDevices(["delay"]);
    const delay = within(device(0));
    clickAndFlush(
      within(delay.getByRole("group", { name: "Division" })).getByRole("radio", {
        name: "1/8 dotted",
      }),
    );
    expect(history.undoSummary).toBe("Set Division to 1/8 dotted");
    clickAndFlush(delay.getByRole("radio", { name: "Free" }));
    expect(history.undoSummary).toBe("Turn Sync off");
    clickAndFlush(delay.getByRole("radio", { name: "Synced" }));
    expect(history.undoSummary).toBe("Turn Sync on");
  });

  it("sets a mode by its name, as one command storing the choice's index", () => {
    const { history, devices, device } = renderDevices(["delay"]);
    const entries = history.entries.length;
    const division = within(device(0)).getByRole("group", { name: "Division" });
    clickAndFlush(within(division).getByRole("radio", { name: "1/8 dotted" }));
    expect(devices()[0].parameters.division).toBe(4);
    expect(history.entries.length).toBe(entries + 1);
    clickAndFlush(within(device(0)).getByRole("radio", { name: "Free" }));
    expect(devices()[0].parameters.sync).toBe(0);
  });

  it("keeps two devices of one type independent", () => {
    const { devices, device } = renderDevices(["delay", "delay"]);
    clickAndFlush(within(device(1)).getByRole("radio", { name: "Free" }));
    expect(devices()[0].parameters.sync).toBe(1);
    expect(devices()[1].parameters.sync).toBe(0);
    // Separate radio groups: the first delay still shows "Synced" checked.
    expect(within(device(0)).getByRole("radio", { name: "Synced" })).toBeChecked();
    expect(within(device(1)).getByRole("radio", { name: "Free" })).toBeChecked();

    const first = within(device(0)).getByRole("slider", { name: "Feedback" });
    const second = within(device(1)).getByRole("slider", { name: "Feedback" });
    expect(first.id).not.toBe(second.id);
  });
});

describe("deviceChoices", () => {
  it("is null for a continuous parameter", () => {
    const [cutoff] = deviceParameters("filter");
    expect(deviceChoices(cutoff)).toBeNull();
  });

  it("falls back to numbers for a stepped mode nobody has named", () => {
    const unnamed = defineParameter({
      id: "test.unnamedMode",
      label: "Mode",
      unit: "normalized",
      min: 0,
      max: 2,
      defaultValue: 0,
      step: 1,
      clampPolicy: "reject",
      automatable: false,
    });
    expect(deviceChoices(unnamed)?.map((choice) => choice.label)).toEqual([
      "0",
      "1",
      "2",
    ]);
  });

  it("reads a compressor's ratio as a ratio", () => {
    const { device } = renderDevices(["compressor"]);
    expect(within(device(0)).getByDisplayValue("3.0:1")).toBeInTheDocument();
  });

  it("shows no bound label, even with a control at its end (#447)", () => {
    const { history, devices, device } = renderDevices(["overdrive"]);
    const overdrive = within(device(0));

    const trackId = history.project.song.tracks[0].id;
    fireAndFlush(() =>
      history.execute(
        setParameter(
          {
            scope: "trackDevice",
            trackId,
            deviceId: devices()[0].id,
            parameterId: "drive",
          },
          1,
        ),
      ),
    );
    // Drive sits at its maximum, and its value field says so.
    expect(overdrive.getAllByDisplayValue("100%")).toHaveLength(1);
    expect(overdrive.queryByText(/at (maximum|minimum)/)).toBeNull();
  });
});
