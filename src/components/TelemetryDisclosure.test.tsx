import { cleanup, render, screen } from "@solidjs/testing-library";
import { type JSX, Show } from "@solidjs/web";
import userEvent from "@testing-library/user-event";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsentStore } from "../analytics/consent";
import { type ShortcutHandlers, useShortcuts } from "../shortcuts";
import ShortcutGuide from "../shortcuts/ShortcutGuide";
import { memoryStorage } from "../testing/storage";
import TelemetryDisclosure from "./TelemetryDisclosure";

afterEach(() => cleanup());

function setup() {
  const storage = memoryStorage();
  const store = new ConsentStore(storage);
  render(() => <TelemetryDisclosure store={store} />);
  return { store, storage };
}

describe("TelemetryDisclosure (PRD OPS-02, section 10 Security and privacy)", () => {
  it("names both processors, so the user is told what is collected", () => {
    setup();
    const body = screen.getByText(/Two processors receive this/).textContent ?? "";
    expect(body).toContain("PostHog");
    expect(body).not.toContain("Google Analytics");
    expect(body).toContain("Sentry");
  });

  it("names PostHog for replay and error reports, alongside Sentry for errors (GRV-120)", () => {
    // ADR 0011: replay moved to PostHog, and error reports go to both while
    // PostHog's error tracking is evaluated. Sentry no longer records.
    setup();
    const body = screen.getByText(/Two processors receive this/).textContent ?? "";
    expect(body).toContain(
      "PostHog for product events, Session Replay and error reports, and Sentry for error reports.",
    );
    expect(body).not.toContain("Sentry for error reports and Session Replay");
  });

  it("states that no project content or typed text is collected", () => {
    setup();
    expect(screen.getByText(/no project, track, or clip names/)).toBeInTheDocument();
  });

  // ADR 0002 decision 5 as revised by ADR 0003 decision 5: "The user is told,
  // before it happens." Replay is a real expansion of collection, so the
  // disclosure names it, says what it is for, and — since canvas capture is on
  // — says plainly that recordings include the user's musical work. Each
  // assertion is separate so a copy edit that drops one fails on that one.
  describe("Session Replay (ADR 0002 decision 5, ADR 0003 decision 5)", () => {
    it("names Session Replay specifically", () => {
      setup();
      expect(screen.getByText(/Session Replay records/)).toBeInTheDocument();
    });

    it("states its purpose: seeing where people get stuck", () => {
      setup();
      expect(screen.getByText(/where people get stuck/)).toBeInTheDocument();
    });

    // The heart of ADR 0003 decision 5. Canvas capture records the arrangement
    // and piano roll, so the disclosure must say the musical work is in the
    // recording. Anything softer would be false.
    it("says recordings include the arrangement, the notes, and section names", () => {
      setup();
      const body = screen.getByText(/Session Replay records/).textContent ?? "";
      expect(body).toContain("arrangement and piano roll");
      expect(body).toContain("the musical work itself");
      expect(body).toContain("names you give sections");
    });

    // ADR 0002 decision 5 required "Your music never leaves your project" stay
    // literally true; ADR 0003 decision 1 ends that, so the sentence must be
    // gone rather than merely contradicted elsewhere in the copy.
    it("does not repeat the superseded promise that music never leaves the project", () => {
      setup();
      expect(screen.queryByText(/never leaves your project/)).toBeNull();
      expect(screen.queryByText(/masked out as the recording is made/)).toBeNull();
    });

    // ADR 0003 decision 2, as amended by GRV-126: a kept conversation also
    // goes to PostHog while product analytics is allowed, never to Sentry, and
    // PostHog's copies expire rather than being deleted. It must agree with
    // the Coproducer settings disclosure (`retentionCopy.ts`), never contradict it.
    it("discloses that kept assistant conversations also go to PostHog", () => {
      setup();
      const body =
        screen.getByText(/Groove keeps your\s+conversations with Coproducer/)
          .textContent ?? "";
      expect(body).toContain("also goes to PostHog");
      expect(body).toContain("only if you allow product analytics");
      expect(body).toContain("never sent to Sentry");
      expect(body).toContain("expire under PostHog's data");
      expect(screen.queryByText(/never sent to PostHog/)).toBeNull();
      expect(
        screen.queryByText(/deleting a project deletes its conversations/),
      ).toBeNull();
    });

    it("turns replay off with the same single control (ADR 0002 decision 4)", async () => {
      const { store } = setup();
      const toggle = screen.getByRole("checkbox", {
        name: /Share usage and error reports/,
      });

      await userEvent.click(toggle);

      expect(store.sessionReplayAllowed).toBe(false);
      expect(store.analyticsAllowed).toBe(false);
      expect(store.errorMonitoringAllowed).toBe(false);
    });

    it("still reads as on while replay alone is being collected", () => {
      // Otherwise the control would show "off" for a state in which session
      // recordings are still being made.
      const store = new ConsentStore(memoryStorage());
      store.set({
        productAnalytics: false,
        errorMonitoring: false,
        sessionReplay: true,
      });
      render(() => <TelemetryDisclosure store={store} />);
      expect(
        screen.getByRole("checkbox", {
          name: /Share usage and error reports/,
        }),
      ).toBeChecked();
    });
  });

  it("promises that opting out costs no capability", () => {
    setup();
    expect(screen.getByText(/Every feature keeps working/)).toBeInTheDocument();
  });

  it("opts the user out through the control", async () => {
    const { store } = setup();
    const toggle = screen.getByRole("checkbox", {
      name: /Share usage and error reports/,
    });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);

    expect(store.analyticsAllowed).toBe(false);
    expect(store.errorMonitoringAllowed).toBe(false);
    expect(toggle).not.toBeChecked();
  });

  it("opts back in", async () => {
    const { store } = setup();
    const toggle = screen.getByRole("checkbox", {
      name: /Share usage and error reports/,
    });

    await userEvent.click(toggle);
    await userEvent.click(toggle);

    expect(store.analyticsAllowed).toBe(true);
    expect(toggle).toBeChecked();
  });

  it("persists the choice, so it survives a reload", async () => {
    const { storage } = setup();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Share usage and error reports/ }),
    );
    expect(new ConsentStore(storage).analyticsAllowed).toBe(false);
  });

  it("reflects a change made elsewhere", () => {
    const { store } = setup();
    store.optOut();
    // Solid 2 batches writes, so the subscription's `setState` is not visible
    // to the rendered checkbox until the batch flushes.
    flush();
    expect(
      screen.getByRole("checkbox", { name: /Share usage and error reports/ }),
    ).not.toBeChecked();
  });

  // `LOOP-001b`: the landing page gives it a designed home in its footer, so
  // it stops floating there. Same control and copy either way.
  it("floats as app chrome by default and sits inline when asked", () => {
    const store = new ConsentStore(memoryStorage());
    const { container } = render(() => (
      <>
        <TelemetryDisclosure store={store} />
        <TelemetryDisclosure store={store} placement="inline" />
      </>
    ));
    const [floating, inline] = [...container.querySelectorAll(".telemetry-disclosure")];
    expect(floating?.classList.contains("telemetry-disclosure-inline")).toBe(false);
    expect(inline?.classList.contains("telemetry-disclosure-inline")).toBe(true);
  });

  it("describes the control for assistive technology", () => {
    setup();
    const toggle = screen.getByRole("checkbox", {
      name: /Share usage and error reports/,
    });
    expect(toggle).toHaveAttribute("aria-describedby", "telemetry-disclosure-note");
  });
});

// GRV-148: Escape closes the panel and gives focus back to the Privacy item,
// through the registry's `view.close_surface`, as every other popover does.
describe("TelemetryDisclosure Escape (GRV-148)", () => {
  async function openPanel() {
    setup();
    const user = userEvent.setup();
    const summary = screen.getByText("Privacy");
    await user.click(summary);
    const details = summary.closest("details") as HTMLDetailsElement;
    await vi.waitFor(() => expect(details.open).toBe(true));
    return { user, summary, details };
  }

  it("closes on Escape and returns focus to the summary", async () => {
    const { user, summary, details } = await openPanel();
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(details.open).toBe(false));
    expect(summary).toHaveFocus();
  });

  it("closes on Escape pressed on the checkbox inside", async () => {
    const { user, summary, details } = await openPanel();
    screen.getByRole("checkbox").focus();
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(details.open).toBe(false));
    expect(summary).toHaveFocus();
  });
});

// GRV-148 QA: a modal dialog opened over the panel (the shortcuts guide in the
// studio) is the topmost surface, so one Escape closes the dialog alone and
// the panel waits for the next one, whichever controller hears the key first.
// In the studio the editor's controller is mounted long before the panel's.
describe("TelemetryDisclosure Escape under a modal dialog (GRV-148)", () => {
  /**
   * A modal's Escape owner, like the editor's: it closes the dialog when open,
   * and, like every real owner, has nothing to close (so leaves the key to
   * the surfaces under it) when it is not.
   */
  function ModalOwner(props: { open: boolean; onClose(): void }): JSX.Element {
    useShortcuts({
      handlers: (): ShortcutHandlers => ({
        "view.close_surface": { run: () => props.onClose(), isEnabled: () => props.open },
      }),
      contexts: () => [],
    });
    return (
      <Show when={props.open}>
        <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" />
      </Show>
    );
  }

  async function openBoth(ownerFirst: boolean) {
    const store = new ConsentStore(memoryStorage());
    const [dialogOpen, setDialogOpen] = createSignal(false);
    const [ownerLate, setOwnerLate] = createSignal(false);
    const owner = () => (
      <ModalOwner open={dialogOpen()} onClose={() => setDialogOpen(false)} />
    );
    render(() => (
      <>
        <Show when={ownerFirst}>{owner()}</Show>
        <TelemetryDisclosure store={store} />
        <Show when={ownerLate()}>{owner()}</Show>
      </>
    ));
    const user = userEvent.setup();
    const summary = screen.getByText("Privacy");
    await user.click(summary);
    const details = summary.closest("details") as HTMLDetailsElement;
    await vi.waitFor(() => expect(details.open).toBe(true));
    if (!ownerFirst) setOwnerLate(true);
    setDialogOpen(true);
    flush();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    return { user, details, dialogOpen };
  }

  for (const ownerFirst of [true, false]) {
    it(`one Escape closes only the dialog (its controller attached ${ownerFirst ? "before" : "after"} the panel's)`, async () => {
      const { user, details, dialogOpen } = await openBoth(ownerFirst);
      await user.keyboard("{Escape}");
      flush();
      expect(dialogOpen()).toBe(false);
      expect(details.open).toBe(true);
      await user.keyboard("{Escape}");
      await vi.waitFor(() => expect(details.open).toBe(false));
    });
  }
});

// GRV-148, second QA: in the studio the editor's controller, mounted long
// before the panel, owns both the Keyboard shortcuts guide's Escape and the
// arrangement's "Escape clears the selection". This stands in for that chain
// with the real guide mounted beside the real panel, each on its own
// controller on the window, as in the app. A browser runs a microtask
// checkpoint between two listeners of one key press, so the guide the editor
// closes is already gone from the document when the panel's listener runs;
// `flush()` in the editor's handler is that checkpoint.
describe("TelemetryDisclosure Escape beside the editor (GRV-148)", () => {
  function EditorStandIn(props: {
    selected: () => boolean;
    clearSelection(): void;
  }): JSX.Element {
    const [guideOpen, setGuideOpen] = createSignal(false);
    useShortcuts({
      handlers: (): ShortcutHandlers => ({
        "help.shortcut_guide": { run: () => setGuideOpen(true) },
        "view.close_surface": {
          run: () => {
            if (guideOpen()) setGuideOpen(false);
            else props.clearSelection();
            flush();
          },
          isEnabled: () => guideOpen() || props.selected(),
        },
      }),
      contexts: () => (guideOpen() ? ["dialog"] : ["editor"]),
    });
    return (
      <Show when={guideOpen()}>
        <ShortcutGuide contexts={["editor"]} onClose={() => setGuideOpen(false)} />
      </Show>
    );
  }

  async function studio() {
    const store = new ConsentStore(memoryStorage());
    const [selected, setSelected] = createSignal(true);
    const clearSelection = vi.fn(() => setSelected(false));
    render(() => (
      <>
        <EditorStandIn selected={selected} clearSelection={clearSelection} />
        <TelemetryDisclosure store={store} />
      </>
    ));
    const user = userEvent.setup();
    const summary = screen.getByText("Privacy");
    await user.click(summary);
    const details = summary.closest("details") as HTMLDetailsElement;
    await vi.waitFor(() => expect(details.open).toBe(true));
    return { user, summary, details, selected, clearSelection };
  }

  it("one Escape closes only the shortcuts guide opened over the panel", async () => {
    const { user, summary, details } = await studio();
    await user.keyboard("?");
    flush();
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    flush();
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(details.open).toBe(true);

    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(details.open).toBe(false));
    expect(summary).toHaveFocus();
  });

  it("one Escape on the panel closes it and leaves the selection alone", async () => {
    const { user, details, selected, clearSelection } = await studio();
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(details.open).toBe(false));
    expect(clearSelection).not.toHaveBeenCalled();
    expect(selected()).toBe(true);

    // With the panel closed, the next Escape is the arrangement's again.
    await user.keyboard("{Escape}");
    expect(clearSelection).toHaveBeenCalledTimes(1);
  });
});
