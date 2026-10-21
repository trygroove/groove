import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { addDevice, CommandHistory, insertChain } from "../../commands";
import { createDevice } from "../../domain/devices";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { frequencyAt } from "../../instrument/filterResponse";
import { testAnalytics } from "../../instrument/panelTesting";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import EqFaceplate from "./EqFaceplate";
import { dbAt } from "./eqCurve";

afterEach(() => cleanup());

function renderEq() {
  const history = new CommandHistory(createPianoRollFixtureProject());
  const trackId = history.project.song.tracks[0].id;
  const id = createSeededIdFactory("eq-faceplate")("device");
  history.execute(addDevice(insertChain(trackId), createDevice(id, "eq", 0)));
  const [project, setProject] = createSignal(history.project);
  history.subscribe(() => setProject(history.project));
  const device = () => project().song.tracks[0].devices[0];
  const { transport, analytics } = testAnalytics();
  const { container } = render(() => (
    <EqFaceplate
      chain={insertChain(trackId)}
      device={device()}
      dispatch={(commands) => history.execute(commands)}
      beginGesture={(gesture) => history.beginGesture(gesture)}
      analytics={analytics}
    />
  ));
  const surface = container.querySelector(".eq-well .drag-surface") as HTMLElement;
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100 }) as DOMRect;
  const pointer = (type: string, x: number, y: number) =>
    fireAndFlush(() =>
      fireEvent(surface, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })),
    );
  const drag = (from: [number, number], to: [number, number]) => {
    pointer("pointerdown", ...from);
    pointer("pointermove", ...to);
    pointer("pointerup", ...to);
  };
  return { history, device, container, transport, drag, pointer };
}

/** Where `hz` sits across the 300 px test well. */
const at = (hz: number) => 300 * (Math.log(hz / 20) / Math.log(1_000));

describe("EqFaceplate (LOOP-022)", () => {
  it("draws the curve with a handle per band, and edits Peak 1 to start", () => {
    const { container } = renderEq();
    expect(container.querySelector(".eq-well .well-line")).not.toBeNull();
    expect(
      [...container.querySelectorAll(".eq-handle")].map((h) => h.textContent),
    ).toEqual(["LC", "LS", "1", "2", "HS", "HC"]);
    expect(screen.getByRole("radio", { name: "Peak 1" })).toBeChecked();
    expect(screen.getByRole("slider", { name: "Peak 1 frequency" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Peak 1 gain" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Peak 1 Q" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Output" })).toBeInTheDocument();
    // Only the band being edited: the others' controls are a choice away.
    expect(screen.queryByRole("slider", { name: "Peak 2 gain" })).toBeNull();
  });

  it("shows a band's controls when it is chosen, and a cut has no gain", () => {
    renderEq();
    clickAndFlush(screen.getByRole("radio", { name: "Low cut" }));
    expect(screen.getByRole("slider", { name: "Low cut frequency" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Low cut Q" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: /gain/i })).toBeNull();
    expect(screen.queryByRole("slider", { name: /Peak 1/ })).toBeNull();
  });

  it("switches a band in through its own switch, as one parameter.set", () => {
    const { history, device } = renderEq();
    clickAndFlush(screen.getByRole("radio", { name: "High cut" }));
    const entries = history.entries.length;
    clickAndFlush(screen.getByRole("radio", { name: "On" }));
    expect(device().parameters.highCutOn).toBe(1);
    expect(history.entries.length).toBe(entries + 1);
  });

  it("drags the nearest band's frequency and gain as one history entry", () => {
    const { history, device, drag } = renderEq();
    const entries = history.entries.length;
    // Peak 2 sits at 3 kHz on the 0 dB line; take it to the left and up.
    const from = 300 * (Math.log(3_000 / 20) / Math.log(1_000));
    drag([from, 50], [150, 25]);
    expect(device().parameters.peak2Freq).toBeCloseTo(frequencyAt(0.5), 0);
    expect(device().parameters.peak2Gain).toBeCloseTo(dbAt(0.75), 5);
    expect(history.entries.length).toBe(entries + 1);
    // The press chose the band, so its controls are the ones shown.
    expect(screen.getByRole("radio", { name: "Peak 2" })).toBeChecked();
  });

  it("switches a band in when it is dragged, since moving it asks to hear it", () => {
    const { device, drag } = renderEq();
    expect(device().parameters.lowCutOn).toBe(0);
    // The low cut's handle is at 30 Hz on the 0 dB line; drag it to 100 Hz.
    drag([at(30), 50], [at(100), 10]);
    expect(device().parameters.lowCutOn).toBe(1);
    expect(device().parameters.lowCutFreq).toBeCloseTo(100, 0);
    // A cut has no gain for the drag to set.
    expect(device().parameters).not.toHaveProperty("lowCutGain");
  });

  it("only picks a band on a click: no edit, no history entry, no first use", () => {
    const { history, device, transport, pointer } = renderEq();
    const before = device().parameters;
    const entries = history.entries.length;
    // A press just left of the switched-off high cut's handle, released unmoved.
    pointer("pointerdown", at(18_000) - 3, 50);
    pointer("pointermove", at(18_000) - 3, 50);
    pointer("pointerup", at(18_000) - 3, 50);
    expect(screen.getByRole("radio", { name: "High cut" })).toBeChecked();
    expect(device().parameters).toEqual(before);
    expect(device().parameters.highCutOn).toBe(0);
    expect(history.entries.length).toBe(entries);
    expect(transport.named("feature_first_use")).toHaveLength(0);
  });

  it("moves a handle from where it was, not to the pointer", () => {
    const { device, drag } = renderEq();
    // Peak 2 sits at 3 kHz on the 0 dB line. Pressed 6 px left of and 10 px
    // below it, then carried 30 px right and 20 px up, it moves by just that.
    drag([at(3_000) - 6, 60], [at(3_000) + 24, 40]);
    expect(device().parameters.peak2Freq).toBeCloseTo(
      frequencyAt((at(3_000) + 30) / 300),
      0,
    );
    expect(device().parameters.peak2Gain).toBeCloseTo(dbAt(0.7), 5);
  });

  it("logs the curve's first use once, however many drags", () => {
    const { transport, drag } = renderEq();
    drag([150, 50], [160, 40]);
    drag([150, 50], [170, 30]);
    expect(
      transport
        .named("feature_first_use")
        .filter((event) => event.params.feature === "eq_curve"),
    ).toHaveLength(1);
  });
});
