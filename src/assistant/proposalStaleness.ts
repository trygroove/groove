/**
 * Which edits make a pending assistant proposal stale (GRV-132).
 *
 * A proposal is validated against one revision. Every committed edit moves the
 * revision, but most edits cannot change whether the proposal still applies or
 * what it would do: switching the loop brace off does not matter to a proposal
 * that mutes a track. Treating every revision change as stale threw such
 * proposals away for nothing.
 *
 * The audit lives in {@link PROPOSAL_COMMAND_IMPACT}, one entry per registered
 * command type. An entry is either
 *
 * - `"song"`: the command changes something a proposal can be built on (notes,
 *   clips, tracks, mixing, instruments, devices, assets, tempo and key). Any
 *   such edit since the proposal's revision makes it stale; or
 * - a named group of state that no proposal is built on, which only conflicts
 *   with a proposal that changes that same group (a proposal that sets the
 *   loop is out of date once someone else moved the loop).
 *
 * A proposal that is not stale still goes through `executeTransaction` when it
 * is applied, so every domain invariant is checked against the song as it is
 * now.
 *
 * `proposalStaleness.test.ts` covers every registered command type, so a new
 * command cannot ship without being decided here.
 */

export type ProposalCommandImpact = "song" | "loop" | "name";

export const PROPOSAL_COMMAND_IMPACT: Readonly<Record<string, ProposalCommandImpact>> = {
  "note.add": "song",
  "note.remove": "song",
  "note.update": "song",
  "notes.transpose": "song",
  "notes.scaleVelocity": "song",
  "notes.quantize": "song",
  "notes.duplicate": "song",
  "notes.clear": "song",
  "notes.vary": "song",
  "notes.quantizeToScale": "song",
  "clip.create": "song",
  "clip.delete": "song",
  "clip.update": "song",
  "track.create": "song",
  "track.delete": "song",
  "track.update": "song",
  "track.reorder": "song",
  "track.setFlag": "song",
  "return.create": "song",
  "return.delete": "song",
  "return.update": "song",
  "send.add": "song",
  "send.remove": "song",
  "placement.create": "song",
  "placement.delete": "song",
  "placement.update": "song",
  "parameter.set": "song",
  "drum.setPadAsset": "song",
  "drum.renamePad": "song",
  "drum.setPadFlag": "song",
  "drum.setPadChoke": "song",
  "drum.setPadParameter": "song",
  "drum.addPad": "song",
  "drum.removePad": "song",
  "drum.reorderPad": "song",
  "instrument.change": "song",
  "instrument.setSample": "song",
  "pack.add": "song",
  "pack.remove": "song",
  "pack.setVersion": "song",
  "asset.add": "song",
  "asset.remove": "song",
  "device.add": "song",
  "device.remove": "song",
  "device.reorder": "song",
  "device.duplicate": "song",
  "device.setBypass": "song",
  "device.reset": "song",
  "device.restoreParameters": "song",
  // Where playback loops: no note, clip or sound a proposal edits depends on it.
  "loop.setRange": "loop",
  "loop.setEnabled": "loop",
  // Only a label; a proposal never reads it.
  "project.rename": "name",
  // The key steers scale-aware proposals (quantize to scale), so it conflicts.
  "key.set": "song",
};

function impactOf(type: string): ProposalCommandImpact {
  // An unknown command is treated as one that could conflict.
  return PROPOSAL_COMMAND_IMPACT[type] ?? "song";
}

/**
 * True when edits of the given types, committed after a proposal's revision,
 * leave it applicable. `committed` is null when they are not all known (a
 * change adopted from another tab, say), which always means stale.
 */
export function editsLeaveProposalValid(
  committed: readonly string[] | null,
  proposed: readonly string[],
): boolean {
  if (committed === null) return false;
  const proposedImpacts = new Set(proposed.map(impactOf));
  return committed.every((type) => {
    const impact = impactOf(type);
    return impact !== "song" && !proposedImpacts.has(impact);
  });
}
