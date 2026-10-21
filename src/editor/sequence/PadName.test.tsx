import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistory } from "../../commands";
import type { DrumPad, Track } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { MAX_DISPLAY_NAME_LENGTH } from "../composition/displayNameLimit";
import PadName from "./PadName";

afterEach(cleanup);

function renderPadName() {
  const history = new CommandHistory(createDrumMachineFixtureProject());
  const track = history.project.song.tracks.find(
    (candidate: Track) => candidate.instrument?.kind === "drumMachine",
  );
  if (!track || track.instrument?.kind !== "drumMachine") {
    throw new Error("expected a drum machine track");
  }
  const pad: DrumPad = track.instrument.pads[0];
  render(() => (
    <PadName
      track={track}
      pad={pad}
      dispatch={(commands) => history.execute(commands)}
      onAudition={vi.fn()}
    />
  ));
  clickAndFlush(screen.getByRole("button", { name: `Rename ${pad.name}` }));
  const input = screen.getByRole("textbox") as HTMLInputElement;
  return { history, pad, input };
}

describe("PadName", () => {
  it("caps the field at the longest name a pad may have", () => {
    const { input } = renderPadName();
    // The domain's `displayName` is `z.string().min(1).max(120)`.
    expect(input.maxLength).toBe(MAX_DISPLAY_NAME_LENGTH);
  });

  it("commits a name of exactly the longest allowed length", () => {
    const { history, pad, input } = renderPadName();
    const longest = "k".repeat(MAX_DISPLAY_NAME_LENGTH);
    input.value = longest;
    fireAndFlush(() => fireEvent.change(input));
    const renamed = history.project.song.tracks.flatMap((track) =>
      track.instrument?.kind === "drumMachine" ? track.instrument.pads : [],
    );
    expect(renamed.find((candidate) => candidate.id === pad.id)?.name).toBe(longest);
  });
});
