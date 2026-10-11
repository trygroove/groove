import { describe, expect, it } from "vitest";
import { validateProposal } from "../../assistant/proposal";
import {
  ASSISTANT_TOOLSET_VERSION,
  EXPLAIN_TOOL_NAME,
  toolNameFor,
} from "../../assistant/tools";
import { controlAddress, SONG_ENTITY } from "../../commands/controlAddress";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { SONG_SWING, SONG_TEMPO, TRACK_VOLUME } from "../../domain/parameters";
import {
  explainProposal,
  previewTarget,
  projectAfter,
  proposalRows,
} from "./proposalCardModel";

const project = createSliceFixtureProject();
const track = project.song.tracks[0];
if (!track) throw new Error("the fixture has no track");

function valid(calls: { name: string; input: unknown }[], intent?: string) {
  const result = validateProposal(project, {
    baseRevision: project.metadata.revision,
    toolsetVersion: ASSISTANT_TOOLSET_VERSION,
    ...(intent ? { intent } : {}),
    calls,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.proposal;
}

const set = (target: unknown, value: number) => ({
  name: toolNameFor("parameter.set"),
  input: { target, value },
});
const swing = set({ scope: "song", parameterId: SONG_SWING.id }, 58);
const tempo = set({ scope: "song", parameterId: SONG_TEMPO.id }, 100);
const volume = set(
  { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
  -3,
);

describe("the proposal card's model (GRV-5)", () => {
  it("reads every changed control before and after", () => {
    const proposal = valid([swing, volume]);
    const rows = proposalRows(
      project,
      projectAfter(project, proposal),
      proposal.impact.controls,
    );
    expect(rows).toEqual([
      {
        address: controlAddress(SONG_ENTITY, "swing"),
        label: "Swing",
        from: "50%",
        to: "58%",
        change: "changed",
      },
      {
        address: controlAddress(track.id, "volume"),
        label: "BD volume",
        from: "0.0 dB",
        to: "-3.0 dB",
        change: "changed",
      },
    ]);
  });

  it("previews in the view that shows a change, past one the header shows everywhere", () => {
    const proposal = valid([swing, volume]);
    const rows = proposalRows(
      project,
      projectAfter(project, proposal),
      proposal.impact.controls,
    );
    expect(previewTarget(project, rows)).toEqual({
      address: controlAddress(track.id, "volume"),
      view: "mixer",
    });
  });

  it("stays where it is for a change only the header shows", () => {
    const proposal = valid([tempo]);
    const rows = proposalRows(
      project,
      projectAfter(project, proposal),
      proposal.impact.controls,
    );
    expect(previewTarget(project, rows)).toEqual({
      address: controlAddress(SONG_ENTITY, "tempo"),
      view: null,
    });
  });

  it("explains with the assistant's goal and technique, and the controls it changes", () => {
    const explanation = {
      goal: "The beat feels played rather than programmed.",
      technique: "Swing delays every second 16th note, the way a drummer's hand lags.",
    };
    const proposal = valid([
      swing,
      volume,
      { name: EXPLAIN_TOOL_NAME, input: explanation },
    ]);
    const rows = proposalRows(
      project,
      projectAfter(project, proposal),
      proposal.impact.controls,
    );
    expect(explainProposal(proposal, rows)).toEqual({ ...explanation, changed: rows });
  });

  it("has nothing to fold out when the assistant gave no explanation", () => {
    // Repeating the request and the rows above it would teach nothing (GRV-5 QA).
    expect(explainProposal(valid([swing], "A beat that sounds played"), [])).toBeNull();
  });
});
