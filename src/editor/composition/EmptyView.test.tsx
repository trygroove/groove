import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickAndFlush } from "../../testing/events";
import EmptyView from "./EmptyView";
import { ViewIcon } from "./viewIcons";

afterEach(cleanup);

function renderEmpty(onFix = vi.fn()) {
  render(() => (
    <EmptyView
      view="sequence"
      title="No clip selected"
      body="Select a clip in the arrangement, then press 2 to edit its steps or notes."
      fixes={[
        { view: "arrangement", label: "Arrangement", keyLabel: "1" },
        { view: "instrument", label: "Instrument", keyLabel: "3" },
      ]}
      onFix={onFix}
    />
  ));
  return onFix;
}

describe("EmptyView", () => {
  it("is a region named by what is missing, with one line on the fix", () => {
    renderEmpty();
    const region = screen.getByRole("region", { name: "No clip selected" });
    expect(
      within(region).getByRole("heading", { name: "No clip selected" }),
    ).toBeVisible();
    expect(region).toHaveTextContent(
      "Select a clip in the arrangement, then press 2 to edit its steps or notes.",
    );
  });

  it("names each fix for its view, and shows the key that does the same", () => {
    renderEmpty();
    const arrangement = screen.getByRole("button", { name: "Arrangement" });
    expect(arrangement).toHaveTextContent("1");
    expect(arrangement).toHaveAttribute("aria-keyshortcuts", "1");
    expect(screen.getByRole("button", { name: "Instrument" })).toHaveTextContent("3");
  });

  it("asks for the fix's view when its button is pressed", () => {
    const onFix = renderEmpty();
    clickAndFlush(screen.getByRole("button", { name: "Instrument" }));
    expect(onFix).toHaveBeenCalledExactlyOnceWith("instrument");
  });

  it("draws the view's icon struck through, hidden from assistive tech", () => {
    renderEmpty();
    const icon = document.querySelector(".empty-view-icon svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon?.querySelector("line")).not.toBeNull();
  });
});

describe("ViewIcon", () => {
  it("draws every view, and is only struck when asked", () => {
    for (const view of [
      "arrangement",
      "sequence",
      "instrument",
      "library",
      "mixer",
    ] as const) {
      const { container, unmount } = render(() => <ViewIcon view={view} />);
      const svg = container.querySelector("svg");
      expect(svg?.childElementCount, view).toBeGreaterThan(0);
      expect(svg?.querySelector("line"), view).toBeNull();
      unmount();
    }
  });
});
