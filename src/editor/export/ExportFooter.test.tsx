import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import ExportFooter, { EXPORT_NOTE_ID, type ExportFooterProps } from "./ExportFooter";

/** The footer on its own: readouts, actions and the message slot (EXP-004). */

afterEach(cleanup);

function renderFooter(props: Partial<ExportFooterProps> = {}) {
  return render(() => (
    <ExportFooter
      format="stems"
      size="1.3 GiB · 21 files"
      zipCount={1}
      printing={null}
      note=""
      alert=""
      {...props}
    >
      <button type="button">Export</button>
    </ExportFooter>
  ));
}

const slot = (label: string) =>
  screen.getByText(label, { selector: ".export-label" }).parentElement;

describe("ExportFooter", () => {
  it("reads the size and, for stems, how many ZIPs they come as", () => {
    renderFooter();
    expect(slot("Size")).toHaveTextContent("1.3 GiB · 21 files");
    expect(slot("Downloads")).toHaveTextContent("1 ZIP");
    cleanup();
    renderFooter({ zipCount: 3 });
    expect(slot("Downloads")).toHaveTextContent("3 ZIPs, each under 2 GiB");
  });

  it("reads the level, not the ZIP count, for a stereo mix", () => {
    renderFooter({ format: "stereo" });
    expect(slot("Level")).toHaveTextContent("Project level, not normalized");
    expect(screen.queryByText("Downloads")).toBeNull();
  });

  it("swaps to what is printing and a progress bar while it renders", () => {
    renderFooter({ printing: { text: "ZIP 2 of 3 · bar 79 of 160", fraction: 0.5 } });
    expect(slot("Printing")).toHaveTextContent("ZIP 2 of 3 · bar 79 of 160");
    expect(screen.getByRole("progressbar", { name: "Export progress" })).toHaveAttribute(
      "value",
      "0.5",
    );
    expect(screen.queryByText("Size")).toBeNull();
  });

  it("gives its slots fixed widths, so nothing moves when they change", () => {
    renderFooter();
    expect(slot("Size")).toHaveStyle({ "--slot-width": "230px" });
    expect(slot("Downloads")).toHaveStyle({ "--slot-width": "220px" });
  });

  it("puts the actions it is given in the actions box", () => {
    renderFooter();
    const actions = document.querySelector(".export-actions") as HTMLElement;
    expect(within(actions).getByRole("button", { name: "Export" })).toBeVisible();
  });

  it("keeps its alert mounted, empty until a failure, with the note beside it", () => {
    const view = renderFooter();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("");
    expect(alert).not.toHaveClass("shown");
    const note = document.getElementById(EXPORT_NOTE_ID) as HTMLElement;
    expect(note).toHaveAttribute("aria-live", "polite");
    view.unmount();
    renderFooter({ alert: "Something went wrong.", note: "A note." });
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong.");
    expect(screen.getByRole("alert")).toHaveClass("shown");
    expect(document.getElementById(EXPORT_NOTE_ID)).toHaveTextContent("A note.");
  });
});
