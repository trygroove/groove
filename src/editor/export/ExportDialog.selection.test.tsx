import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../domain/entities";
import { createReferenceProject } from "../../domain/fixtures";
import { createStemFixtureProject } from "../../export/stems/stemFixture";
import { stubCanvasContext } from "../../testing/canvas";
import { clickAndFlush } from "../../testing/events";
import { fakeStemsBatch } from "../../testing/stemsBatchFake";
import ExportDialog from "./ExportDialog";
import { formatExportSize } from "./stemSelection";
import type { StemsBatchRequest } from "./stemsExport";

/** The stems dialog's track selection and size budget (EXP-003, #66), now made on
 * the track list's rows rather than on checkboxes (EXP-004). */

afterEach(cleanup);
stubCanvasContext();

function renderDialog(project: Project) {
  const fake = fakeStemsBatch();
  const requests: StemsBatchRequest[] = [];
  const download = vi.fn();
  render(() => (
    <ExportDialog
      project={() => project}
      exportStemsBatch={
        ((p: Project, request: StemsBatchRequest) => {
          requests.push(request);
          return fake.exportStemsBatch(p, request);
        }) as never
      }
      download={download}
      onClose={vi.fn()}
    />
  ));
  clickAndFlush(screen.getByRole("radio", { name: "Stems (ZIP)" }));
  return { requests, download };
}

const exportButton = () => screen.getByRole("button", { name: "Export" });
/** A track's row: its name is `<name>, included` or `<name>, left out`. */
const row = (name: string) =>
  screen
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-label")?.startsWith(`${name}, `)) as
    | HTMLElement
    | undefined;
const toggle = (name: string) => clickAndFlush(row(name) as HTMLElement);
const isOn = (name: string) =>
  row(name)?.getAttribute("aria-label")?.endsWith(", included");
const ordered = (project: Project) =>
  [...project.song.tracks].sort((a, b) => a.order - b.order);

describe("ExportDialog: choosing the tracks in a stem export", () => {
  it("includes every track by default, and exports them all", async () => {
    const project = createStemFixtureProject();
    const { requests } = renderDialog(project);
    const tracks = ordered(project);
    for (const track of tracks) expect(isOn(track.name)).toBe(true);
    clickAndFlush(exportButton());
    expect(requests.map((r) => r.trackIds)).toEqual([tracks.map((track) => track.id)]);
  });

  it("exports only the tracks left included", async () => {
    const project = createStemFixtureProject();
    const { requests } = renderDialog(project);
    const [lead, bass] = ordered(project);
    toggle(lead.name);
    expect(isOn(lead.name)).toBe(false);
    clickAndFlush(exportButton());
    expect(requests.map((r) => r.trackIds)).toEqual([[bass.id]]);
  });

  // #844: the effect that starts the export over read the phase in its
  // untracked apply half, so every toggle logged a Solid dev warning.
  it("toggles a stem without a STRICT_READ_UNTRACKED warning (#844)", () => {
    const warn = vi.spyOn(console, "warn");
    const project = createStemFixtureProject();
    renderDialog(project);
    const [lead] = ordered(project);
    toggle(lead.name);
    toggle(lead.name);
    const strictReads = warn.mock.calls.filter(([message]) =>
      String(message).includes("STRICT_READ_UNTRACKED"),
    );
    warn.mockRestore();
    expect(strictReads).toHaveLength(0);
  });

  it("turns Export off with no track on, and says why", () => {
    const project = createStemFixtureProject();
    const { requests } = renderDialog(project);
    const button = exportButton();
    expect(button).not.toHaveAttribute("aria-disabled");
    for (const track of ordered(project)) toggle(track.name);
    // Off stays focusable, so its reason is read out, and does nothing.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-describedby", "export-note");
    expect(document.getElementById("export-note")).toHaveTextContent(
      "Turn on at least one track to export stems.",
    );
    clickAndFlush(button);
    expect(requests).toEqual([]);
  });

  describe("with the PRD reference project (50 tracks, ten minutes, 44.1 kHz)", () => {
    const project = createReferenceProject();
    const tracks = ordered(project);

    // One option per track, in track order: queried once, because a role
    // query over fifty of them is slow in jsdom.
    const turnOff = (rows: HTMLElement[]) => {
      for (const option of rows) clickAndFlush(option);
    };
    const trackRows = () => screen.getAllByRole("option").slice(0, 50);

    it("shows the size, which shrinks as tracks are left out", () => {
      renderDialog(project);
      const size = () => screen.getByText("Size").nextElementSibling?.textContent;
      expect(size()).toBe("7.44 GiB \u00b7 51 files");
      turnOff(trackRows().slice(0, 1));
      expect(size()).toBe("7.29 GiB \u00b7 50 files");
    });

    it("never blocks Export over the budget: it splits, and fewer tracks mean fewer ZIPs", () => {
      const { requests } = renderDialog(project);
      const rows = trackRows();
      expect(rows).toHaveLength(50);
      const zips = () =>
        screen.getByText("Downloads", { selector: ".export-footer .export-label" })
          .parentElement?.textContent;
      expect(exportButton()).not.toHaveAttribute("aria-disabled");
      expect(zips()).toMatch(/\d+ ZIPs, each under 2 GiB$/);
      // 12 tracks and the reference mix fit one ZIP; a thirteenth does not.
      turnOff(rows.slice(13));
      expect(zips()).toMatch(/^Downloads2 ZIPs/);
      turnOff(rows.slice(12, 13));
      expect(zips()).toBe("Downloads1 ZIP");
      clickAndFlush(exportButton());
      expect(requests.map((r) => r.trackIds)).toEqual([
        tracks.slice(0, 12).map((track) => track.id),
      ]);
      expect(requests[0].count).toBe(1);
    });
  });
});

describe("formatExportSize", () => {
  it("formats sizes in binary units", () => {
    expect(formatExportSize(512)).toBe("1 MiB");
    expect(formatExportSize(300 * 1024 ** 2)).toBe("300 MiB");
    expect(formatExportSize(1.25 * 1024 ** 3)).toBe("1.25 GiB");
    // Two decimals, so a ZIP under the limit never rounds up to it.
    expect(formatExportSize(1.96 * 1024 ** 3)).toBe("1.96 GiB");
    expect(formatExportSize(4.57 * 1024 ** 3)).toBe("4.57 GiB");
    expect(formatExportSize(2 * 1024 ** 3)).toBe("2 GiB");
    // The floor: an empty or tiny export still reads as 1 MiB.
    expect(formatExportSize(0)).toBe("1 MiB");
  });
});
