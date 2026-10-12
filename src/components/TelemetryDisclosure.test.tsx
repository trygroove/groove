import { cleanup, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentStore } from "../analytics/consent";
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

    // ADR 0003 decision 2: retained first-party, never sent to a third-party
    // processor, and deletion follows the project.
    it("discloses that assistant conversations are stored, and stay with us", () => {
      setup();
      const body =
        screen.getByText(/conversations with the assistant are stored/).textContent ?? "";
      expect(body).toContain("never sent to PostHog or Sentry");
      expect(body).toContain("deleting a project deletes its conversations");
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
