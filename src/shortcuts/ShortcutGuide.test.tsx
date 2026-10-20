import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import {
  createRecordingTransport,
  type RecordingTransport,
} from "../analytics/transport";
import { clickAndFlush, fireAndFlush } from "../testing/events";
import { memoryStorage } from "../testing/storage";
import type { ShortcutActionId } from "./registry";
import ShortcutGuide from "./ShortcutGuide";
import type { ShortcutContext } from "./types";

afterEach(() => cleanup());

function renderGuide(
  options: {
    contexts?: readonly ShortcutContext[];
    isEnabled?: (id: ShortcutActionId) => boolean;
    platform?: "mac" | "other";
    analytics?: Analytics;
    onClose?: () => void;
  } = {},
): { transport: RecordingTransport; onClose: () => void } {
  const transport = createRecordingTransport();
  const analytics =
    options.analytics ??
    new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
  analytics.setAccountType("anonymous");
  const onClose = options.onClose ?? vi.fn();
  render(() => (
    <ShortcutGuide
      contexts={options.contexts ?? ["editor", "step_editor"]}
      isEnabled={options.isEnabled}
      platform={options.platform ?? "other"}
      analytics={analytics}
      onClose={onClose}
    />
  ));
  return { transport, onClose };
}

function rowFor(action: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-action="${action}"]`);
  if (!row) throw new Error(`no guide row for ${action}`);
  return row;
}

describe("generated content", () => {
  it("is a titled modal dialog with instructions", () => {
    renderGuide();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      screen.getByRole("heading", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(/Press Escape to close/);
  });

  it("groups the registry into the PRD KEY-02 sections", () => {
    renderGuide();

    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Transport",
      "Global Editing",
      "Arrangement",
      "Clips and Notes",
      "Automation",
      "Mixer and Devices",
      "Browser",
      "Navigation",
    ]);
  });

  it("labels keys for the current platform", () => {
    renderGuide({ platform: "mac" });
    expect(rowFor("edit.undo").textContent).toContain("Cmd+Z");

    cleanup();

    renderGuide({ platform: "other" });
    expect(rowFor("edit.undo").textContent).toContain("Ctrl+Z");
  });

  it("shows the Ableton equivalent, or why Groove differs", () => {
    renderGuide();

    expect(rowFor("transport.play_stop").textContent).toContain(
      "Same as Ableton Live (Space)",
    );
    expect(rowFor("clip.quantize").textContent).toContain("Live uses Cmd/Ctrl+U");
    expect(rowFor("help.shortcut_guide").textContent).toContain("Groove addition");
  });

  it("notes a browser combination Groove takes over", () => {
    renderGuide();

    expect(rowFor("edit.duplicate").textContent).toMatch(/Browser conflict/i);
  });
});

describe("search and context filter", () => {
  it("searches by action name", () => {
    renderGuide();

    fireAndFlush(() =>
      fireEvent.input(screen.getByLabelText("Search shortcuts"), {
        target: { value: "quantize" },
      }),
    );

    expect(document.querySelectorAll("[data-action]")).toHaveLength(1);
    expect(rowFor("clip.quantize")).toBeInTheDocument();
  });

  it("searches by key combination", () => {
    renderGuide({ platform: "other" });

    fireAndFlush(() =>
      fireEvent.input(screen.getByLabelText("Search shortcuts"), {
        target: { value: "ctrl+shift" },
      }),
    );

    expect(rowFor("edit.redo")).toBeInTheDocument();
    expect(document.querySelector('[data-action="edit.undo"]')).toBeNull();
  });

  it("reports when nothing matches", () => {
    renderGuide();

    fireAndFlush(() =>
      fireEvent.input(screen.getByLabelText("Search shortcuts"), {
        target: { value: "sidechain" },
      }),
    );

    expect(screen.getByText("No shortcuts match your search.")).toBeVisible();
  });

  it("marks shortcuts that are not valid in the current context", () => {
    renderGuide({ contexts: ["editor"] });

    expect(rowFor("transport.play_stop")).toHaveAttribute("data-available", "true");
    // `E` splits a clip in the arrangement, which this surface does not show.
    expect(rowFor("arrangement.split_clip")).toHaveAttribute("data-available", "false");
    expect(rowFor("arrangement.split_clip").textContent).toContain("Not available here");
  });

  it("marks a registered action whose handler is disabled", () => {
    renderGuide({
      contexts: ["editor"],
      isEnabled: (id) => id !== "edit.undo",
    });

    expect(rowFor("edit.undo")).toHaveAttribute("data-available", "false");
    expect(rowFor("edit.redo")).toHaveAttribute("data-available", "true");
  });

  it("filters to what is available right now on request", () => {
    renderGuide({ contexts: ["editor"] });

    clickAndFlush(
      screen.getByLabelText("Only shortcuts available here", { exact: false }),
    );

    expect(document.querySelector('[data-action="arrangement.split_clip"]')).toBeNull();
    expect(rowFor("transport.play_stop")).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("focuses the search field on open", () => {
    renderGuide();

    expect(document.activeElement).toBe(screen.getByLabelText("Search shortcuts"));
  });

  it("restores focus to the element that had it when the guide closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    renderGuide();
    expect(document.activeElement).not.toBe(opener);

    cleanup();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("wraps Tab from the last focusable element back to the first", () => {
    renderGuide();

    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByLabelText("Search shortcuts"));
  });

  it("wraps Shift+Tab from the first focusable element to the last", () => {
    renderGuide();

    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Tab",
      shiftKey: true,
    });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("closes through its own button as well as the Escape mapping", () => {
    const onClose = vi.fn();
    renderGuide({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // GRV-186: the guide's own modal scope owns Escape, so one press closes it
  // once and is logged once, from the search field that has focus.
  it("closes once on Escape and logs shortcut_used once", () => {
    const onClose = vi.fn();
    const { transport } = renderGuide({ onClose });

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    const used = transport.events.filter((event) => event.name === "shortcut_used");
    expect(used).toHaveLength(1);
    expect(used[0]?.params.action_id).toBe("view.close_surface");
  });
});

describe("analytics", () => {
  it("logs the shortcut_guide feature_first_use key once per account", () => {
    const transport = createRecordingTransport();
    const analytics = new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    analytics.setAccountType("anonymous");

    renderGuide({ analytics });
    cleanup();
    renderGuide({ analytics });

    const firstUse = transport.events.filter(
      (event) => event.name === "feature_first_use",
    );
    expect(firstUse).toHaveLength(1);
    expect(firstUse[0]?.params.feature).toBe("shortcut_guide");
  });
});
