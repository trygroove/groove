import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { createSignal, For, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDevice, CommandHistory, insertChain, setParameter } from "../../commands";
import { createDevice, type DeviceTypeId, deviceTypes } from "../../domain/devices";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import { createSeededIdFactory } from "../../domain/ids";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import DeviceCard from "./DeviceCard";

afterEach(() => cleanup());

/** A track carrying `types`, each rendered as a card over a real history. */
function renderChain(
  types: readonly DeviceTypeId[],
  options: { canDuplicate: boolean; tempo?: number } = { canDuplicate: true },
) {
  const history = new CommandHistory(createPianoRollFixtureProject());
  const trackId = history.project.song.tracks[0].id;
  const ids = createSeededIdFactory("device-card");
  types.forEach((type, order) => {
    history.execute(
      addDevice(insertChain(trackId), createDevice(ids("device"), type, order)),
    );
  });
  const [project, setProject] = createSignal(history.project);
  history.subscribe(() => setProject(history.project));
  const devices = () => project().song.tracks[0].devices;
  const copyIds = createSeededIdFactory("device-card-copies");
  const copyId = copyIds("device");
  render(() => (
    <ul aria-label="Chain">
      {/* Keyed on the id, as the panel is: keyed on the object, an edit would
          remount the card under the pointer. */}
      <For each={devices()} keyed={(device) => device.id}>
        {(device) => (
          <li>
            <DeviceCard
              chain={insertChain(trackId)}
              device={device()}
              canDuplicate={options.canDuplicate}
              newDeviceId={() => copyId}
              dispatch={(commands) => history.execute(commands)}
              beginGesture={(gesture) => history.beginGesture(gesture)}
              tempo={options.tempo}
            />
          </li>
        )}
      </For>
    </ul>
  ));
  const card = (index: number) => within(screen.getAllByRole("listitem")[index]);
  const types_ = () => devices().map((device) => device.type);
  return { history, devices, card, types: types_, trackId, copyId };
}

/**
 * The selectors in `DeviceCard.css` that style a bypassed card, split by what
 * they do: dimming text (they reassign a colour token) or fading the drawing
 * (they set an opacity). jsdom does not apply the stylesheet, so a test asks
 * whether these selectors reach the elements they are meant to.
 */
function bypassSelectors(): { dim: string[]; fade: string[] } {
  const css = readFileSync(join(__dirname, "DeviceCard.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const dim: string[] = [];
  const fade: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.includes(".bypassed")) continue;
    const selectors = selector.split(",").map((part) => part.trim());
    if (body.includes("--color-text:")) dim.push(...selectors);
    if (body.includes("opacity:")) fade.push(...selectors);
  }
  return { dim, fade };
}

describe("DeviceCard", () => {
  // #844: the well read the device's type in its component body, which Solid's
  // dev build reported as STRICT_READ_UNTRACKED on every card it drew.
  it("draws a device's well without a STRICT_READ_UNTRACKED warning (#844)", () => {
    const warn = vi.spyOn(console, "warn");
    renderChain(["overdrive", "compressor", "delay", "filter"]);
    const strictReads = warn.mock.calls.filter(([message]) =>
      String(message).includes("STRICT_READ_UNTRACKED"),
    );
    warn.mockRestore();
    expect(strictReads).toHaveLength(0);
  });

  it("names the device and gives it its own controls", () => {
    const { card } = renderChain(["reverb"]);
    expect(card(0).getByRole("heading", { name: "Reverb" })).toBeInTheDocument();
    expect(card(0).getByRole("slider", { name: "Size" })).toBeInTheDocument();
  });

  it("gives the EQ its own faceplate: the curve, and the band being edited (LOOP-022)", () => {
    const { card } = renderChain(["eq"]);
    expect(card(0).getByRole("heading", { name: "EQ" })).toBeInTheDocument();
    expect(card(0).getByRole("group", { name: "Band" })).toBeInTheDocument();
    // Named in full for assistive tech, and by its bank's own word on screen.
    const gain = card(0).getByRole("slider", { name: "Peak 1 gain" });
    expect(gain.closest(".fill-slider")?.textContent).toContain("Gain");
    expect(gain.closest(".fill-slider")?.textContent).not.toContain("Peak 1 gain");
  });

  it("bypasses in place, keeping its settings, as one undoable entry", () => {
    const { history, devices, card } = renderChain(["overdrive", "reverb"]);
    const entries = history.entries.length;
    const before = devices()[0].parameters;
    const bypass = card(0).getByRole("button", { name: "Bypass Overdrive" });
    expect(bypass).toHaveAttribute("aria-pressed", "false");

    clickAndFlush(bypass);
    expect(bypass).toHaveAttribute("aria-pressed", "true");
    expect(devices()[0]).toMatchObject({
      type: "overdrive",
      bypassed: true,
      parameters: before,
    });
    expect(history.entries.length).toBe(entries + 1);

    clickAndFlush(bypass);
    expect(devices()[0].bypassed).toBe(false);
    fireAndFlush(() => history.undo());
    expect(devices()[0].bypassed).toBe(true);
  });

  // GRV-64: the dimming rules matched only `.device-card-body`, which the EQ's
  // faceplate replaces, so a bypassed EQ looked exactly like an active one.
  it.each(deviceTypes().map((definition) => definition.type))(
    "recedes a bypassed %s's body and well, but not its header (GRV-64)",
    (type) => {
      const { card } = renderChain([type]);
      const article = screen.getByRole("article");
      const { dim, fade } = bypassSelectors();
      const dimmed = (element: Element) =>
        dim.some((selector) => element.closest(selector) !== null);
      const faded = (element: Element) =>
        fade.some((selector) => element.matches(selector));
      const sliders = card(0).getAllByRole("slider");
      const drawings = [...article.querySelectorAll(".well-screen > svg")];

      // Active, nothing recedes.
      expect(sliders.filter(dimmed)).toEqual([]);
      expect(drawings.filter(faded)).toEqual([]);

      clickAndFlush(card(0).getByRole("button", { name: /^Bypass / }));
      expect(article).toHaveClass("bypassed");
      expect(sliders.filter((slider) => !dimmed(slider))).toEqual([]);
      expect(drawings.filter((drawing) => !faded(drawing))).toEqual([]);
      // The header, and the way back in, stay at full strength.
      expect(dimmed(card(0).getByRole("heading"))).toBe(false);
      expect(dimmed(card(0).getByRole("button", { name: /^Bypass / }))).toBe(false);
    },
  );

  it("offers its actions as named icon buttons, with no reorder arrows", () => {
    const { card } = renderChain(["overdrive", "reverb"]);
    // The name is a sortable button for the keyboard's moves, not an action.
    expect(card(0).getByRole("button", { name: "Overdrive" })).toHaveAttribute(
      "aria-roledescription",
      "sortable",
    );
    const actions = card(0)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-roledescription") !== "sortable");
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Bypass Overdrive",
      "Duplicate Overdrive",
      "Reset Overdrive",
      "Remove Overdrive",
    ]);
    for (const button of actions) {
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).not.toBeNull();
    }
  });

  it("duplicates directly after itself with the same settings and the given id", () => {
    const { history, devices, card, types, trackId, copyId } = renderChain([
      "reverb",
      "overdrive",
    ]);
    history.execute(
      setParameter(
        { scope: "trackDevice", trackId, deviceId: devices()[0].id, parameterId: "size" },
        0.8,
      ),
    );
    const entries = history.entries.length;
    clickAndFlush(card(0).getByRole("button", { name: "Duplicate Reverb" }));
    expect(types()).toEqual(["reverb", "reverb", "overdrive"]);
    expect(devices()[1]).toMatchObject({ id: copyId, parameters: { size: 0.8 } });
    expect(history.entries.length).toBe(entries + 1);
  });

  it("offers no duplicate once the chain is full", () => {
    const { card } = renderChain(["reverb"], { canDuplicate: false });
    expect(card(0).getByRole("button", { name: "Duplicate Reverb" })).toBeDisabled();
  });

  it("resets to the definition's defaults, and undo brings the settings back", () => {
    const { history, devices, card, trackId } = renderChain(["reverb"]);
    history.execute(
      setParameter(
        { scope: "trackDevice", trackId, deviceId: devices()[0].id, parameterId: "size" },
        0.9,
      ),
    );
    const size = card(0).getByRole("slider", { name: "Size" });
    flush();
    expect(size).toHaveValue("0.9");

    clickAndFlush(card(0).getByRole("button", { name: "Reset Reverb" }));
    expect(size).toHaveValue("0.5");
    fireAndFlush(() => history.undo());
    expect(size).toHaveValue("0.9");
  });

  it("removes, and undo puts it back in the same place", () => {
    const { history, card, types } = renderChain(["reverb", "delay", "overdrive"]);
    const entries = history.entries.length;
    clickAndFlush(card(1).getByRole("button", { name: "Remove Delay" }));
    expect(types()).toEqual(["reverb", "overdrive"]);
    expect(history.entries.length).toBe(entries + 1);
    fireAndFlush(() => history.undo());
    expect(types()).toEqual(["reverb", "delay", "overdrive"]);
  });
});

describe("DeviceCard faceplate (#447)", () => {
  it("stands its controls in titled banks", () => {
    const { card } = renderChain(["compressor"]);
    for (const title of ["Dynamics", "Timing", "Gain"]) {
      expect(card(0).getByText(title)).toBeInTheDocument();
    }
    // Banks are titled in text, not headings: the card's name is its heading.
    expect(card(0).getAllByRole("heading")).toHaveLength(1);
  });

  it("draws a filter's response in a well, and sets cutoff and resonance from it", () => {
    const { card, devices, history } = renderChain(["filter", "compressor"]);
    expect(card(1).queryByText(/drag the point/)).toBeNull();
    expect(card(1).getByText("Curve")).toBeInTheDocument();
    const surface = screen
      .getAllByRole("listitem")[0]
      .querySelector(".filter-well .drag-surface") as HTMLElement;
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100 }) as DOMRect;
    const entries = history.entries.length;

    const pointer = (type: string) =>
      fireAndFlush(() =>
        surface.dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 50 }),
        ),
      );
    pointer("pointerdown");
    pointer("pointerup");

    expect(devices()[0].parameters.cutoff).toBeCloseTo(200, 0);
    expect(devices()[0].parameters.resonance).toBeCloseTo(15);
    expect(history.entries.length).toBe(entries + 1);
  });
});

describe("DeviceCard shaping and space wells (#447)", () => {
  it("draws an overdrive's transfer and sets tone and drive from its point", () => {
    const { card, devices } = renderChain(["overdrive", "reverb"]);
    expect(card(0).getByText("Transfer")).toBeInTheDocument();
    expect(card(1).getByText("Tail")).toBeInTheDocument();
    const surface = screen
      .getAllByRole("listitem")[0]
      .querySelector(".transfer-well .drag-surface") as HTMLElement;
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }) as DOMRect;
    fireAndFlush(() =>
      surface.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 20 }),
      ),
    );
    expect(devices()[0].parameters.tone).toBeCloseTo(0.25);
    expect(devices()[0].parameters.drive).toBeCloseTo(0.8);
  });
});

describe("DeviceCard dynamics and time wells (#447)", () => {
  const surfaceOf = (index: number, well: string) => {
    const surface = screen
      .getAllByRole("listitem")
      [index].querySelector(`.${well} .drag-surface`) as HTMLElement;
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }) as DOMRect;
    return (x: number, y: number) =>
      fireAndFlush(() =>
        surface.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }),
        ),
      );
  };

  it("sets a compressor's threshold from its knee and its ratio from the curve's end", () => {
    const { devices } = renderChain(["compressor"]);
    const press = surfaceOf(0, "compressor-well");
    // The default knee sits at -12 dB in: press near it, further left.
    press(80, 60);
    expect(devices()[0].parameters.threshold).toBeCloseTo(-36);

    // Pressing the right edge at the height of -15 dB out (default makeup 3)
    // gives (0 - -36) / ((-15 - 3) - -36) = 2:1.
    press(200, 100 * (1 - (-15 + 60) / 84));
    expect(devices()[0].parameters.ratio).toBeCloseTo(2);
  });

  it("snaps a synced delay's echo to the nearest division, and sets feedback", () => {
    const { devices } = renderChain(["delay"]);
    const press = surfaceOf(0, "delay-well");
    // At 120 BPM a quarter note is 0.5 s: a quarter of the 2 s window.
    press(50, 50);
    expect(devices()[0].parameters.division).toBe(5);
    expect(devices()[0].parameters.feedback).toBeCloseTo(0.495, 2);
  });

  it("shows a synced delay's real time in its Time control, as the header does (#865)", () => {
    const { devices, card } = renderChain(["delay"], { canDuplicate: true, tempo: 122 });
    clickAndFlush(card(0).getByRole("radio", { name: "1/8 dotted" }));
    expect(devices()[0].parameters.sync).toBe(1);

    // 1/8 dotted at 122 BPM: (240 / 122) * (1.5 / 8) = 0.369 s.
    expect(card(0).getByText("1/8 dotted · 369 ms")).toBeInTheDocument();
    const time = card(0).getByRole("slider", { name: "Time" });
    expect(card(0).getByRole("textbox", { name: "Time value" })).toHaveValue("369 ms");
    expect(time).toHaveAttribute("aria-valuetext", "369 ms");
    // The division sets the time while synced; the free time is not in use.
    expect(time).toBeDisabled();

    // Free timing hands the control back its own stored value.
    clickAndFlush(card(0).getByRole("radio", { name: "Free" }));
    expect(card(0).getByRole("textbox", { name: "Time value" })).toHaveValue("250 ms");
    expect(time).toBeEnabled();
  });
});
