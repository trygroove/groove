import { describe, expect, it } from "vitest";
import { expandTakesCall, parseTakesCall } from "../../assistant/takes";
import { createReferenceProject } from "../../domain/fixtures";
import { offerTakesInput, TAKES_STEM, takesTrackId } from "../../testing/takes";
import { checkTakes } from "./takesCardModel";

const project = createReferenceProject();

/** An offer of four takes of a new track whose `track_create` asks for `order`. */
function offerAt(order: number) {
  const input = offerTakesInput(project);
  const takes = input.takes.map((take) => ({
    ...take,
    calls: take.calls.map((call) =>
      call.name === "track_create" ? { ...call, input: { ...call.input, order } } : call,
    ),
  }));
  const written = expandTakesCall(
    { id: "toolu_1", name: "offer_takes", input: { ...input, takes } },
    TAKES_STEM,
  );
  if (!written.ok) throw new Error(written.message);
  const parsed = parseTakesCall(written.call);
  if (!parsed) throw new Error("the offer did not parse");
  return parsed;
}

describe("checkTakes (GRV-207)", () => {
  it("puts a new track asking for a position past the last track last, rather than refusing every take", () => {
    const tracks = project.song.tracks.length;
    const checked = checkTakes(project, offerAt(tracks + 1), project.metadata.revision);
    expect(checked.stale).toBe(false);
    for (const row of checked.rows) {
      expect(row.commands).not.toBeNull();
      const create = row.commands?.find((command) => command.type === "track.create");
      expect((create?.payload as { track: { id: string; order: number } }).track).toEqual(
        expect.objectContaining({ id: takesTrackId(), order: tracks }),
      );
    }
  });

  it("keeps a position inside the song where it was asked for", () => {
    const checked = checkTakes(project, offerAt(0), project.metadata.revision);
    const create = checked.rows[0]?.commands?.find(
      (command) => command.type === "track.create",
    );
    expect((create?.payload as { track: { order: number } }).track.order).toBe(0);
  });
});
