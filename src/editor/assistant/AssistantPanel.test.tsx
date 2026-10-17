import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import AssistantPanel, { CLEARANCE_PROPERTY, UNAVAILABLE_NOTE } from "./AssistantPanel";
import { LAYOUT_STORAGE_KEY, loadLayout } from "./assistantPanelLayout";
import {
  type AssistantPanel as PanelState,
  useAssistantPanel,
} from "./useAssistantPanel";

afterEach(cleanup);

function recordingAnalytics(transport: ReturnType<typeof createRecordingTransport>) {
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  return analytics;
}

/** The panel with an opener beside it, as the editor's header button is. */
function renderPanel(
  storage: Storage = memoryStorage(),
  analytics: Analytics = recordingAnalytics(createRecordingTransport()),
) {
  let state!: PanelState;
  const [underModal, setUnderModal] = createSignal(false);
  const Harness = () => {
    state = useAssistantPanel({ storage, analytics: () => analytics });
    return (
      <>
        <button type="button" onClick={(event) => state.toggle(event.currentTarget)}>
          Open it
        </button>
        <AssistantPanel panel={state} underModal={underModal} />
      </>
    );
  };
  render(() => <Harness />);
  return { state: () => state, storage, setUnderModal };
}

/** A storage that counts its writes. */
function countingStorage() {
  const inner = memoryStorage();
  let writes = 0;
  const storage = {
    get length() {
      return inner.length;
    },
    clear: () => inner.clear(),
    getItem: (key: string) => inner.getItem(key),
    key: (index: number) => inner.key(index),
    removeItem: (key: string) => inner.removeItem(key),
    setItem: (key: string, value: string) => {
      writes += 1;
      inner.setItem(key, value);
    },
  } as Storage;
  return { storage, writes: () => writes };
}

const clearance = () =>
  document.documentElement.style.getPropertyValue(CLEARANCE_PROPERTY);

const panel = () => screen.getByRole("region", { name: "Cue" });
const queryPanel = () => screen.queryByRole("region", { name: "Cue" });
const button = (name: string) => within(panel()).getByRole("button", { name });
const edge = () => within(panel()).getByRole("separator");
const opener = () => screen.getByRole("button", { name: "Open it" });

/** A drag on the edge, with mouse-shaped pointer events (jsdom has no PointerEvent). */
function drag(
  target: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const pointer = (type: string, at: { x: number; y: number }) =>
    new MouseEvent(type, { bubbles: true, button: 0, clientX: at.x, clientY: at.y });
  fireAndFlush(() => target.dispatchEvent(pointer("pointerdown", from)));
  fireAndFlush(() => target.dispatchEvent(pointer("pointermove", to)));
  fireAndFlush(() => target.dispatchEvent(pointer("pointerup", to)));
}

describe("AssistantPanel", () => {
  it("starts closed, then opens floating with focus inside it", () => {
    renderPanel();
    expect(queryPanel()).toBeNull();

    clickAndFlush(opener());
    expect(panel()).toHaveAttribute("data-mode", "floating");
    expect(panel()).toHaveFocus();
    expect(button("Minimise")).toBeInTheDocument();
    expect(button("Dock to the right")).toBeInTheDocument();
    expect(button("Close")).toBeInTheDocument();
  });

  it("shows an empty conversation and a disabled composer that says why", () => {
    renderPanel();
    clickAndFlush(opener());
    const log = within(panel()).getByRole("log", { name: "Conversation" });
    expect(log).toBeEmptyDOMElement();
    const composer = within(panel()).getByRole("textbox", {
      name: "Message Cue",
    });
    expect(composer).toBeDisabled();
    expect(composer).toHaveAccessibleDescription(UNAVAILABLE_NOTE);
  });

  it("minimises to a bar that names it, and a click on the bar floats it again", () => {
    renderPanel();
    clickAndFlush(opener());
    clickAndFlush(button("Minimise"));
    expect(panel()).toHaveAttribute("data-mode", "minimised");
    expect(panel()).toHaveTextContent("Cue");
    expect(within(panel()).queryByRole("separator")).toBeNull();
    expect(within(panel()).queryByRole("log")).toBeNull();

    clickAndFlush(within(panel()).getByText("Cue"));
    expect(panel()).toHaveAttribute("data-mode", "floating");
    // Restore is the keyboard's way back from the bar.
    clickAndFlush(button("Minimise"));
    clickAndFlush(button("Restore"));
    expect(panel()).toHaveAttribute("data-mode", "floating");
  });

  it("docks and floats, with a separator that announces the size it controls", () => {
    renderPanel();
    clickAndFlush(opener());
    expect(edge()).toHaveAccessibleName("Resize height");
    expect(edge()).toHaveAttribute("aria-orientation", "horizontal");
    expect(edge()).toHaveAttribute("aria-valuenow", "560");
    expect(edge()).toHaveAttribute("aria-valuemin", "260");
    // jsdom's window is 768px tall: 718px of room under the editor's header.
    expect(edge()).toHaveAttribute("aria-valuemax", "718");

    clickAndFlush(button("Dock to the right"));
    expect(panel()).toHaveAttribute("data-mode", "docked");
    expect(within(panel()).queryByRole("button", { name: "Minimise" })).toBeNull();
    expect(edge()).toHaveAccessibleName("Resize width");
    expect(edge()).toHaveAttribute("aria-orientation", "vertical");
    expect(edge()).toHaveAttribute("aria-valuenow", "384");
    expect(edge()).toHaveAttribute("aria-valuemin", "300");
    expect(edge()).toHaveAttribute("aria-valuemax", "640");

    clickAndFlush(button("Float"));
    expect(panel()).toHaveAttribute("data-mode", "floating");
  });

  it("closes and gives focus back to the control that opened it", () => {
    renderPanel();
    opener().focus();
    clickAndFlush(opener());
    expect(panel()).toHaveFocus();
    button("Close").focus();
    clickAndFlush(button("Close"));
    expect(queryPanel()).toBeNull();
    expect(opener()).toHaveFocus();
  });

  it("resizes by dragging its edge, within the limits, and resets on a double-click", () => {
    const { state } = renderPanel();
    clickAndFlush(opener());
    // Up grows the floating panel.
    drag(edge(), { x: 0, y: 400 }, { x: 0, y: 280 });
    expect(state().layout().height).toBe(680);
    expect(edge()).toHaveAttribute("aria-valuenow", "680");
    drag(edge(), { x: 0, y: 400 }, { x: 0, y: 0 });
    expect(state().layout().height).toBe(718);
    fireAndFlush(() => fireEvent.dblClick(edge()));
    expect(state().layout().height).toBe(560);

    // Left grows the docked panel.
    clickAndFlush(button("Dock to the right"));
    drag(edge(), { x: 900, y: 0 }, { x: 780, y: 0 });
    expect(state().layout().width).toBe(504);
    drag(edge(), { x: 900, y: 0 }, { x: 1600, y: 0 });
    expect(state().layout().width).toBe(300);
    fireAndFlush(() => fireEvent.dblClick(edge()));
    expect(state().layout().width).toBe(384);
  });

  it("grows to 1000px in a tall window, and stays on screen as the window shrinks", () => {
    const height = window.innerHeight;
    const resizeWindow = (to: number) =>
      fireAndFlush(() => {
        window.innerHeight = to;
        window.dispatchEvent(new Event("resize"));
      });
    try {
      resizeWindow(1200);
      const { state } = renderPanel();
      clickAndFlush(opener());
      expect(edge()).toHaveAttribute("aria-valuemax", "1000");
      drag(edge(), { x: 0, y: 900 }, { x: 0, y: 0 });
      expect(state().layout().height).toBe(1000);
      expect(panel().style.getPropertyValue("--assistant-height")).toBe("1000px");

      // A 600px window leaves 550px under the header: the panel shows that
      // much, announces it, and keeps the height it was given for later.
      resizeWindow(600);
      expect(panel().style.getPropertyValue("--assistant-height")).toBe("550px");
      expect(edge()).toHaveAttribute("aria-valuenow", "550");
      expect(edge()).toHaveAttribute("aria-valuemax", "550");
      expect(state().layout().height).toBe(1000);
      // The next drag starts from what is on screen and stops at the room.
      drag(edge(), { x: 0, y: 400 }, { x: 0, y: 0 });
      expect(state().layout().height).toBe(550);

      resizeWindow(1200);
      expect(panel().style.getPropertyValue("--assistant-height")).toBe("550px");
      expect(edge()).toHaveAttribute("aria-valuemax", "1000");
    } finally {
      resizeWindow(height);
    }
  });

  it("remembers its mode and both sizes on this device", () => {
    const storage = memoryStorage();
    renderPanel(storage);
    clickAndFlush(opener());
    drag(edge(), { x: 0, y: 400 }, { x: 0, y: 300 });
    clickAndFlush(button("Dock to the right"));
    drag(edge(), { x: 900, y: 0 }, { x: 800, y: 0 });
    expect(storage.getItem(LAYOUT_STORAGE_KEY)).not.toBeNull();
    expect(loadLayout(storage)).toEqual({
      mode: "docked",
      home: "docked",
      height: 660,
      width: 484,
    });
    cleanup();

    // A reload: it comes back docked at the width it was left.
    renderPanel(storage);
    expect(panel()).toHaveAttribute("data-mode", "docked");
    expect(edge()).toHaveAttribute("aria-valuenow", "484");
    clickAndFlush(button("Float"));
    expect(edge()).toHaveAttribute("aria-valuenow", "660");
  });

  it("remembers a drag once, when it ends, not on every pointer move", () => {
    const { storage, writes } = countingStorage();
    renderPanel(storage);
    clickAndFlush(opener());
    const before = writes();
    const pointer = (type: string, y: number) =>
      new MouseEvent(type, { bubbles: true, button: 0, clientX: 0, clientY: y });
    fireAndFlush(() => edge().dispatchEvent(pointer("pointerdown", 400)));
    for (const y of [390, 370, 340, 300]) {
      fireAndFlush(() => edge().dispatchEvent(pointer("pointermove", y)));
    }
    expect(writes()).toBe(before);
    expect(edge()).toHaveAttribute("aria-valuenow", "660");
    fireAndFlush(() => edge().dispatchEvent(pointer("pointerup", 300)));
    expect(writes()).toBe(before + 1);
    expect(loadLayout(storage).height).toBe(660);
  });

  it("sits under a modal dialog, inert, and comes back when it closes", () => {
    const { setUnderModal } = renderPanel();
    clickAndFlush(opener());
    expect(panel()).not.toHaveAttribute("inert");
    fireAndFlush(() => setUnderModal(true));
    const region = document.querySelector(".assistant-panel");
    expect(region).toHaveAttribute("inert");
    expect(region).toHaveClass("assistant-panel-under-modal");
    fireAndFlush(() => setUnderModal(false));
    expect(panel()).not.toHaveAttribute("inert");
    expect(panel()).not.toHaveClass("assistant-panel-under-modal");
  });

  it("publishes the room it takes at the right edge for the app's corner chrome", () => {
    renderPanel();
    expect(clearance()).toBe("0px");
    clickAndFlush(opener());
    expect(clearance()).toBe("400px");
    clickAndFlush(button("Minimise"));
    expect(clearance()).toBe("356px");
    clickAndFlush(button("Dock to the right"));
    expect(clearance()).toBe("384px");
    clickAndFlush(button("Close"));
    expect(clearance()).toBe("0px");
    cleanup();
    expect(clearance()).toBe("");
  });

  it("falls back to the defaults when its storage is corrupt", () => {
    const storage = memoryStorage();
    storage.setItem(LAYOUT_STORAGE_KEY, '{"mode":"docked","width":99999');
    renderPanel(storage);
    expect(queryPanel()).toBeNull();
    clickAndFlush(opener());
    expect(panel()).toHaveAttribute("data-mode", "floating");
    expect(edge()).toHaveAttribute("aria-valuenow", "560");
  });

  it("logs the assistant's first use the first time it opens, and only then", () => {
    const transport = createRecordingTransport();
    renderPanel(memoryStorage(), recordingAnalytics(transport));
    clickAndFlush(opener());
    clickAndFlush(opener());
    clickAndFlush(opener());
    const firstUse = transport
      .named("feature_first_use")
      .map((event) => event.params?.feature);
    expect(firstUse).toEqual(["assistant"]);
  });
});
