import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../domain/entities";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { stubCanvasContext } from "../../testing/canvas";
import { clickAndFlush } from "../../testing/events";
import ExportDialog from "./ExportDialog";

/** A song with no tracks has nothing to export (GRV-151). */

afterEach(cleanup);
stubCanvasContext();

function emptyProject(): Project {
  const project = createSliceFixtureProject();
  return { ...project, song: { ...project.song, tracks: [] } };
}

describe("the Export dialog for a song with no tracks", () => {
  for (const format of ["Stereo WAV", "Stems (ZIP)"]) {
    it(`turns Export off and says so (${format})`, () => {
      const exportWav = vi.fn();
      const download = vi.fn();
      const project = emptyProject();
      render(() => (
        <ExportDialog
          project={() => project}
          exportWav={exportWav as never}
          download={download}
          onClose={vi.fn()}
        />
      ));
      clickAndFlush(
        screen.getByRole("radio", { name: new RegExp(format.split(" ")[0]) }),
      );
      const button = screen.getByRole("button", { name: "Export" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAttribute("aria-describedby", "export-note");
      expect(document.getElementById("export-note")).toHaveTextContent(
        "Add a track to export.",
      );
      expect(screen.getAllByText("Nothing to export").length).toBeGreaterThan(0);
      clickAndFlush(button);
      expect(exportWav).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
      expect(screen.queryByText(/is out/)).toBeNull();
    });
  }
});
