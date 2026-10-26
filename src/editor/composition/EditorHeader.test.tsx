import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, createStore, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { TICKS_PER_BAR, TICKS_PER_QUARTER } from "../../domain/time";
import { memoryStorage } from "../../testing/storage";
import EditorHeader, {
  type ExportRequest,
  type HeaderAudio,
  type HeaderSession,
} from "./EditorHeader";
import type { EditorSessionState } from "./useEditorSession";

afterEach(cleanup);

/** A fake audio module: real signals behind the accessors, spies for the verbs. */
function fakeAudio() {
  const [isPlaying, setPlaying] = createSignal(false);
  const [positionTicks, setPositionTicks] = createSignal(0);
  const [loopEnabled, setLoopEnabled] = createSignal(false);
  const [metronomeEnabled, setMetronomeEnabled] = createSignal(false);
  const audio: HeaderAudio = {
    isPlaying,
    positionTicks,
    loopEnabled,
    metronomeEnabled,
    toggle: vi.fn(async () => {
      setPlaying((playing) => !playing);
    }),
    toggleMetronome: vi.fn(() => setMetronomeEnabled((on) => !on)),
    seekTicks: vi.fn((ticks: number) => setPositionTicks(ticks)),
  };
  const toggleLoop = vi.fn(() => setLoopEnabled((on) => !on));
  return { audio, setPositionTicks, toggleLoop };
}

/** A fake session: a store for the state the header reads, spies for the verbs. */
function fakeSession(overrides: Partial<EditorSessionState> = {}) {
  const [state, setState] = createStore<{
    -readonly [K in keyof EditorSessionState]: EditorSessionState[K];
  }>({
    loading: false,
    notFound: false,
    error: null,
    project: createSliceFixtureProject(),
    previewing: false,
    canUndo: false,
    canRedo: false,
    undoSummary: null,
    redoSummary: null,
    saveStatus: null,
    droppedPlacements: 0,
    ...overrides,
  });
  const session: HeaderSession = {
    state,
    undo: vi.fn(() => null),
    redo: vi.fn(() => null),
    retry: vi.fn(() => undefined),
  };
  return { session, setState };
}

/** A real `Analytics` over a recording transport, as `Mixer.test.tsx` builds it. */
function recordingAnalytics() {
  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
  analytics.setAccountType("anonymous");
  return { analytics, consent, transport };
}

function renderHeader(
  session: HeaderSession,
  audio: HeaderAudio,
  onToggleLoop: () => void = () => {},
  analytics: Analytics = recordingAnalytics().analytics,
  onRename: (name: string) => void = () => {},
  swing: () => number = () => 50,
) {
  return render(() => (
    <EditorHeader
      projectName="Untitled"
      onRename={onRename}
      session={session}
      audio={audio}
      onToggleLoop={onToggleLoop}
      tempo={() => 120}
      onTempoChange={() => {}}
      swing={swing}
      onSwingInput={() => {}}
      onSwingCommit={() => {}}
      onOpenGuide={() => {}}
      keyHint={() => "K"}
      analytics={analytics}
    />
  ));
}

describe("EditorHeader", () => {
  it("opens the Export dialog from the header and closes it again", () => {
    renderHeader(fakeSession().session, fakeAudio().audio);
    expect(screen.queryByRole("dialog", { name: "Export" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    flush();
    expect(screen.getByRole("dialog", { name: "Export" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close export" }));
    flush();
    expect(screen.queryByRole("dialog", { name: "Export" })).toBeNull();
  });

  it("opens the Export dialog on stems when asked, as a lesson does (GRV-44)", () => {
    const [request, setRequest] = createSignal<ExportRequest | null>(null);
    const { session } = fakeSession();
    render(() => (
      <EditorHeader
        projectName="Untitled"
        onRename={() => {}}
        session={session}
        audio={fakeAudio().audio}
        onToggleLoop={() => {}}
        tempo={() => 120}
        onTempoChange={() => {}}
        swing={() => 50}
        onSwingInput={() => {}}
        onSwingCommit={() => {}}
        onOpenGuide={() => {}}
        keyHint={() => "K"}
        analytics={recordingAnalytics().analytics}
        exportRequest={request}
      />
    ));
    expect(screen.queryByRole("dialog", { name: "Export" })).toBeNull();
    setRequest({ format: "stems" });
    flush();
    expect(screen.getByRole("dialog", { name: "Export" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Stems (ZIP)" })).toBeChecked();

    // Closed, the next time it opens from its button it is the usual stereo.
    fireEvent.click(screen.getByRole("button", { name: "Close export" }));
    flush();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    flush();
    expect(screen.getByRole("radio", { name: "Stereo WAV" })).toBeChecked();
  });

  it("offers no export before a project has loaded", () => {
    renderHeader(fakeSession({ project: null }).session, fakeAudio().audio);
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  });

  it("renames the project in place: click, type, Enter commits once", async () => {
    const onRename = vi.fn();
    renderHeader(
      fakeSession().session,
      fakeAudio().audio,
      undefined,
      undefined,
      onRename,
    );

    fireEvent.click(screen.getByRole("button", { name: "Untitled" }));
    const input = await screen.findByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "  Night Drive " } });

    expect(onRename).toHaveBeenCalledExactlyOnceWith("Night Drive");
    // The input gives way to the button once the edit is over.
    await screen.findByRole("button", { name: "Untitled" });
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
  });

  it("commits nothing for an empty or unchanged name", async () => {
    const onRename = vi.fn();
    renderHeader(
      fakeSession().session,
      fakeAudio().audio,
      undefined,
      undefined,
      onRename,
    );

    for (const value of ["   ", "Untitled"]) {
      fireEvent.click(await screen.findByRole("button", { name: "Untitled" }));
      const input = await screen.findByRole("textbox", { name: "Project name" });
      fireEvent.change(input, { target: { value } });
    }
    expect(onRename).not.toHaveBeenCalled();
  });

  it("drives the audio module it is handed and tracks its accessors", async () => {
    const { audio, setPositionTicks, toggleLoop } = fakeAudio();
    renderHeader(fakeSession().session, audio, toggleLoop);

    fireEvent.click(screen.getByRole("button", { name: "Start playback" }));
    expect(audio.toggle).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Stop playback" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Enable loop" }));
    expect(toggleLoop).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: "Disable loop" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enable metronome" }));
    expect(
      await screen.findByRole("button", { name: "Disable metronome" }),
    ).toBeInTheDocument();

    expect(screen.getByText("Playhead at bar 1.1")).toBeInTheDocument();
    setPositionTicks(192 * 5);
    flush();
    expect(screen.getByText("Playhead at bar 2.2")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Bar" })).toHaveValue(2);
    expect(screen.getByRole("spinbutton", { name: "Beat" })).toHaveValue(2);
  });

  it("reads history from the session and routes undo/redo back to it", () => {
    const { session, setState } = fakeSession();
    renderHeader(session, fakeAudio().audio);

    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeDisabled();

    setState((draft) => {
      draft.canUndo = true;
      draft.undoSummary = "add note";
      draft.canRedo = true;
    });
    flush();
    const enabledUndo = screen.getByRole("button", { name: "Undo add note" });
    expect(enabledUndo).toBeEnabled();
    fireEvent.click(enabledUndo);
    expect(session.undo).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(session.redo).toHaveBeenCalledOnce();
  });

  it("groups the controls into the project, playing, and document zones (#819)", () => {
    const { container } = renderHeader(fakeSession().session, fakeAudio().audio);
    const zone = (name: string) =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          `.editor-header-${name} :is(a, button, input, fieldset)`,
        ),
      )
        .filter((el) => !el.closest(".playhead-position") || el.tagName === "FIELDSET")
        .map((el) => el.getAttribute("aria-label") || el.id || null);

    expect(zone("start")).toEqual(["Projects", null]);
    expect(
      container.querySelector(".editor-header-start .project-name-button"),
    ).toHaveTextContent("Untitled");
    expect(zone("center")).toEqual([
      "Start playback",
      "Enable loop",
      "Playhead",
      "Tempo (BPM)",
      "Swing",
      "Enable metronome",
    ]);
    expect(zone("end")).toEqual(["Undo", "Redo", null, "Keyboard shortcuts"]);
    expect(
      container.querySelector(".editor-header-end .export-button"),
    ).toHaveTextContent("Export");
  });

  it("ends the document zone with the account control it is handed (#951)", () => {
    const { container } = render(() => (
      <EditorHeader
        projectName="Untitled"
        onRename={() => {}}
        session={fakeSession().session}
        audio={fakeAudio().audio}
        onToggleLoop={() => {}}
        tempo={() => 120}
        onTempoChange={() => {}}
        swing={() => 50}
        onSwingInput={() => {}}
        onSwingCommit={() => {}}
        onOpenGuide={() => {}}
        keyHint={() => "K"}
        analytics={recordingAnalytics().analytics}
        account={<button type="button">Log in</button>}
      />
    ));
    const end = Array.from(
      container.querySelectorAll<HTMLElement>(".editor-header-end button"),
    );
    expect(end.at(-1)).toHaveTextContent("Log in");
  });

  it("joins play with loop, the song settings, and undo with redo", () => {
    const { container } = renderHeader(fakeSession().session, fakeAudio().audio);
    const groups = Array.from(container.querySelectorAll(".header-cell-group"));
    const names = groups.map((group) =>
      Array.from(group.querySelectorAll("button, input")).map(
        (el) => el.getAttribute("aria-label") ?? el.id,
      ),
    );
    expect(names).toEqual([
      ["Start playback", "Enable loop"],
      ["Tempo (BPM)", "Swing", "Enable metronome"],
      ["Undo", "Redo"],
    ]);
  });

  it("sizes every icon to fit its 26px cell", () => {
    renderHeader(fakeSession().session, fakeAudio().audio);
    const iconSize = (el: HTMLElement) => el.querySelector("svg")?.getAttribute("width");

    expect(iconSize(screen.getByRole("link", { name: "Projects" }))).toBe("16");
    expect(iconSize(screen.getByRole("button", { name: "Start playback" }))).toBe("18");
    for (const name of [
      "Undo",
      "Redo",
      "Enable loop",
      "Enable metronome",
      "Keyboard shortcuts",
    ]) {
      expect(iconSize(screen.getByRole("button", { name }))).toBe("18");
    }
  });

  it("draws Stop smaller than Play so the two glyphs read as one size", async () => {
    const { audio } = fakeAudio();
    renderHeader(fakeSession().session, audio);
    fireEvent.click(screen.getByRole("button", { name: "Start playback" }));
    const stop = await screen.findByRole("button", { name: "Stop playback" });
    expect(stop.querySelector("svg")?.getAttribute("width")).toBe("14");
  });

  describe("swing button (#500)", () => {
    const button = () => screen.getByRole("button", { name: "Swing" });

    it("is a popup button showing its value, reporting its expanded state", () => {
      renderHeader(
        fakeSession().session,
        fakeAudio().audio,
        undefined,
        undefined,
        undefined,
        () => 62,
      );
      expect(button()).toHaveAttribute("aria-haspopup", "dialog");
      expect(button()).toHaveAttribute("aria-expanded", "false");
      expect(button()).toHaveAttribute("title", "Swing 62%");
      expect(button().querySelector("svg")?.getAttribute("width")).toBe("16");
      expect(button()).toHaveTextContent("62%");
      expect(screen.queryByRole("slider", { name: "Swing" })).toBeNull();
    });

    it("reads as on above 50% and idle at 50%", () => {
      renderHeader(
        fakeSession().session,
        fakeAudio().audio,
        undefined,
        undefined,
        undefined,
        () => 50,
      );
      expect(button()).not.toHaveClass("is-on");
      cleanup();
      renderHeader(
        fakeSession().session,
        fakeAudio().audio,
        undefined,
        undefined,
        undefined,
        () => 51,
      );
      expect(button()).toHaveClass("is-on");
    });

    it("opens onto the slider, and Escape closes it back onto the button", async () => {
      renderHeader(fakeSession().session, fakeAudio().audio);
      fireEvent.click(button());
      const slider = await screen.findByRole("slider", { name: "Swing" });
      expect(button()).toHaveAttribute("aria-expanded", "true");
      await vi.waitFor(() => expect(slider).toHaveFocus());

      fireEvent.keyDown(window, { key: "Escape" });
      await vi.waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
      expect(button()).toHaveAttribute("aria-expanded", "false");
      expect(button()).toHaveFocus();
    });

    it("closes on a press outside", async () => {
      renderHeader(fakeSession().session, fakeAudio().audio);
      fireEvent.click(button());
      await screen.findByRole("slider", { name: "Swing" });
      fireEvent.pointerDown(document.body);
      await vi.waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
    });
  });

  it("drops the time signature and prints BPM as decoration only (#819)", () => {
    const { container } = renderHeader(fakeSession().session, fakeAudio().audio);
    expect(container.querySelector(".time-signature")).toBeNull();
    expect(screen.queryByText("4/4", { exact: false })).toBeNull();
    expect(screen.getByText("BPM")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("spinbutton", { name: "Tempo (BPM)" })).toBeInTheDocument();
  });

  // #866: the tempo box was named only by a visually-hidden `<label for>`, so
  // an audit reading the name off the element itself found it unlabelled.
  it("names the tempo box on the element itself (#866)", () => {
    renderHeader(fakeSession().session, fakeAudio().audio);
    expect(screen.getByRole("spinbutton", { name: "Tempo (BPM)" })).toHaveAttribute(
      "aria-label",
      "Tempo (BPM)",
    );
  });

  // GRV-220: an empty or non-numeric entry, and an Escape, put the song's
  // current tempo back in the box; none of them commits a tempo change.
  describe("the tempo box (GRV-220)", () => {
    function renderTempo(onTempoChange: (bpm: number) => void) {
      return render(() => (
        <EditorHeader
          projectName="Untitled"
          onRename={() => {}}
          session={fakeSession().session}
          audio={fakeAudio().audio}
          onToggleLoop={() => {}}
          tempo={() => 120}
          onTempoChange={onTempoChange}
          swing={() => 50}
          onSwingInput={() => {}}
          onSwingCommit={() => {}}
          onOpenGuide={() => {}}
          keyHint={() => "K"}
          analytics={recordingAnalytics().analytics}
        />
      ));
    }
    const tempoField = () => screen.getByRole("spinbutton", { name: "Tempo (BPM)" });
    const type = (value: string) => {
      const field = tempoField();
      fireEvent.focus(field);
      flush();
      fireEvent.input(field, { target: { value } });
      fireEvent.change(field, { target: { value } });
      flush();
    };

    it("restores the current tempo when the box is cleared and committed", () => {
      const onTempoChange = vi.fn();
      renderTempo(onTempoChange);
      type("");
      expect(tempoField()).toHaveValue(120);
      fireEvent.blur(tempoField());
      flush();
      expect(tempoField()).toHaveValue(120);
      expect(onTempoChange).not.toHaveBeenCalled();
    });

    it("restores the current tempo when non-numeric text is committed", () => {
      const onTempoChange = vi.fn();
      renderTempo(onTempoChange);
      // A number input reports letters as an empty value.
      type("fast");
      expect(tempoField()).toHaveValue(120);
      expect(onTempoChange).not.toHaveBeenCalled();
    });

    it("discards a typed value on Escape, and a later blur commits nothing", () => {
      const onTempoChange = vi.fn();
      renderTempo(onTempoChange);
      const field = tempoField();
      // Real focus, as a click gives it: Escape acts on the focused box.
      field.focus();
      flush();
      fireEvent.input(field, { target: { value: "77" } });
      flush();
      fireEvent.keyDown(window, { key: "Escape" });
      flush();
      expect(tempoField()).toHaveValue(120);
      expect(field).not.toHaveFocus();
      fireEvent.blur(field);
      flush();
      expect(tempoField()).toHaveValue(120);
      expect(onTempoChange).not.toHaveBeenCalled();
    });

    it("commits a typed tempo once, as a change", () => {
      const onTempoChange = vi.fn();
      renderTempo(onTempoChange);
      type("77");
      expect(onTempoChange).toHaveBeenCalledTimes(1);
      expect(onTempoChange).toHaveBeenCalledWith(77);
    });
  });

  it("seeks to a bar and beat typed into the playhead", () => {
    const { audio } = fakeAudio();
    renderHeader(fakeSession().session, audio);

    // Each step is its own browser event; Solid settles writes between them.
    const type = (name: string, value: string) => {
      const field = screen.getByRole("spinbutton", { name });
      fireEvent.focus(field);
      flush();
      fireEvent.change(field, { target: { value } });
      flush();
      fireEvent.blur(field);
      flush();
    };

    type("Bar", "3");
    expect(audio.seekTicks).toHaveBeenLastCalledWith(TICKS_PER_BAR * 2);
    type("Beat", "4");
    expect(audio.seekTicks).toHaveBeenLastCalledWith(
      TICKS_PER_BAR * 2 + TICKS_PER_QUARTER * 3,
    );
    expect(screen.getByText("Playhead at bar 3.4")).toBeInTheDocument();
  });

  it("keeps a committed segment while its neighbour is still being edited", () => {
    const { audio } = fakeAudio();
    renderHeader(fakeSession().session, audio);

    // Enter commits without blurring, so the hold has to move with the seek
    // or the next commit would pair the new beat with the old bar.
    const bar = screen.getByRole("spinbutton", { name: "Bar" });
    fireEvent.focus(bar);
    flush();
    fireEvent.change(bar, { target: { value: "3" } });
    flush();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Beat" }), {
      target: { value: "2" },
    });
    expect(audio.seekTicks).toHaveBeenLastCalledWith(
      TICKS_PER_BAR * 2 + TICKS_PER_QUARTER,
    );
  });

  it("clamps a typed position and ignores an emptied segment", () => {
    const { audio } = fakeAudio();
    renderHeader(fakeSession().session, audio);

    const beat = screen.getByRole("spinbutton", { name: "Beat" });
    fireEvent.change(beat, { target: { value: "9" } });
    expect(audio.seekTicks).toHaveBeenLastCalledWith(TICKS_PER_QUARTER * 3);
    expect(beat).toHaveValue(4);

    const bar = screen.getByRole("spinbutton", { name: "Bar" });
    fireEvent.change(bar, { target: { value: "" } });
    expect(audio.seekTicks).toHaveBeenCalledOnce();
    expect(bar).toHaveValue(1);
  });

  it("holds the shown position while a segment is being edited", () => {
    const { audio, setPositionTicks } = fakeAudio();
    renderHeader(fakeSession().session, audio);

    const bar = screen.getByRole("spinbutton", { name: "Bar" });
    fireEvent.focus(bar);
    flush();
    setPositionTicks(TICKS_PER_BAR * 6);
    flush();
    expect(bar).toHaveValue(1);
    fireEvent.blur(bar);
    flush();
    expect(bar).toHaveValue(7);
  });

  it("marks playhead_seek as first used once, and seeks with analytics off", () => {
    const { analytics, transport } = recordingAnalytics();
    const { audio } = fakeAudio();
    renderHeader(fakeSession().session, audio, () => {}, analytics);

    const bar = screen.getByRole("spinbutton", { name: "Bar" });
    fireEvent.change(bar, { target: { value: "2" } });
    fireEvent.change(bar, { target: { value: "5" } });
    expect(transport.named("feature_first_use")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ feature: "playhead_seek" }),
      }),
    ]);

    cleanup();
    const off = recordingAnalytics();
    off.consent.set({ productAnalytics: false });
    const offAudio = fakeAudio().audio;
    renderHeader(fakeSession().session, offAudio, () => {}, off.analytics);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Bar" }), {
      target: { value: "2" },
    });
    expect(offAudio.seekTicks).toHaveBeenCalledWith(TICKS_PER_BAR);
    expect(off.transport.events).toEqual([]);
  });
});
