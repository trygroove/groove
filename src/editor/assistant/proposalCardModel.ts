/**
 * What an assistant proposal's card shows (GRV-5): a row per control it would
 * change, old to new; where Preview takes the editor; and "Why this works".
 * Pure functions of the project and the validated proposal, so the card's
 * words are testable without rendering it.
 */

import type { ValidProposal } from "../../assistant/proposal";
import { CONTROL_PARTS, type ControlAddress } from "../../commands/controlAddress";
import { executeTransaction } from "../../commands/execute";
import { readControl } from "../../controls/readControl";
import type { Project } from "../../domain/entities";
import { controlHome } from "../controlReveal";
import type { EditorViewName } from "../editorViews";

/** One control the proposal changes, as the card lists it. */
export interface ProposalRow {
  readonly address: ControlAddress;
  readonly label: string;
  /** What it reads now; `null` when it has no single value, or does not exist yet. */
  readonly from: string | null;
  /** What it would read; `null` when it has no single value, or would be gone. */
  readonly to: string | null;
  /** Whether the proposal creates it, or removes it. */
  readonly change: "changed" | "added" | "removed";
}

/** Library bookkeeping a command records, with no control a producer would look at. */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  CONTROL_PARTS.packs,
  CONTROL_PARTS.assets,
]);

/** The project the proposal would leave, or `before` itself if it no longer applies. */
export function projectAfter(before: Project, proposal: ValidProposal): Project {
  const result = executeTransaction(before, proposal.commands, {
    actor: "assistant",
    commitRevision: false,
  });
  return result.ok ? result.project : before;
}

/**
 * A row per control the proposal changes, in the order its commands touch
 * them, each read in the project before and after it. A control with nothing
 * to read on either side keeps its place under a plain label, so the list
 * never hides a change.
 */
export function proposalRows(
  before: Project,
  after: Project,
  controls: readonly ControlAddress[],
): ProposalRow[] {
  return controls
    .filter((address) => !BOOKKEEPING.has(address.param))
    .map((address) => {
      const was = readControl(before, address);
      const now = readControl(after, address);
      return {
        address,
        label: now?.label ?? was?.label ?? "A change",
        from: was?.value ?? null,
        to: now?.value ?? null,
        change: !was && now ? "added" : was && !now ? "removed" : "changed",
      };
    });
}

/**
 * The control Preview reveals: the first one that lives in a particular
 * view, so the editor goes where the change can be seen. A proposal whose
 * every control is in the header (the tempo) stays on the view it is on.
 */
export function previewTarget(
  project: Project,
  rows: readonly ProposalRow[],
): { readonly address: ControlAddress; readonly view: EditorViewName | null } | null {
  let first: { address: ControlAddress; view: EditorViewName | null } | null = null;
  for (const row of rows) {
    const home = controlHome(project, row.address);
    if (home.view) return { address: row.address, view: home.view };
    first ??= { address: row.address, view: null };
  }
  return first;
}

/** "Why this works": the goal, the technique and the controls it changes. */
export interface ProposalExplanation {
  /** What the producer will hear, in the assistant's words. */
  readonly goal: string;
  /** The production idea that gets there, in the assistant's words. */
  readonly technique: string;
  /** The controls the proposal actually changes, from its dry run. */
  readonly changed: readonly ProposalRow[];
}

/**
 * Explains a proposal: the goal and technique the assistant gave with it
 * (`explain_change`), and the controls it changes, which come from what the
 * proposal does rather than what it says, so they can never name a control it
 * leaves alone. With no explanation from the assistant there is nothing worth
 * folding out: repeating the request and the rows above it teaches nothing.
 */
export function explainProposal(
  proposal: ValidProposal,
  rows: readonly ProposalRow[],
): ProposalExplanation | null {
  if (!proposal.explanation) return null;
  return {
    goal: proposal.explanation.goal,
    technique: proposal.explanation.technique,
    changed: rows,
  };
}
