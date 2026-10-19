/**
 * A proposal streamed part by part (GRV-144): what one part does, what it
 * needs, and how its line reads. Pure functions of the project and the part,
 * so the card's words and the order parts can apply in are testable without
 * rendering anything.
 *
 * A part is one change call the gateway accepted. It is checked on its own,
 * through the same validator a whole proposal goes through, against the
 * project it would apply to: the song as it is, with every earlier part the
 * producer has not applied yet on top. A part that refers to something an
 * earlier part makes (clips on a track the proposal creates) **needs** that
 * part, and cannot apply before it.
 */
import {
  type ProposalIssue,
  type ValidProposal,
  validateProposal,
} from "../../assistant/proposal";
import type { AssistantProposal, AssistantProposalPart } from "../../assistant/protocol";
import { executeTransaction } from "../../commands/execute";
import type { RawCommandInput } from "../../commands/types";
import type { Project } from "../../domain/entities";
import { TICKS_PER_BAR } from "../../domain/time";
import { type ProposalRow, proposalRows } from "./proposalCardModel";
import { type RejectionIssue, rejectionReason } from "./rejectionReason";

/** One part that fits the song it would apply to. */
export interface ResolvedPart {
  readonly ok: true;
  /** The part as a proposal of one command, its impact read against `before`. */
  readonly proposal: ValidProposal;
  readonly command: RawCommandInput;
  /** Every ID the part makes: tracks, pads, devices, returns, clips, notes, placements, sections. */
  readonly creates: ReadonlySet<string>;
  /** What its line says: the track, and its length when it has one. */
  readonly line: PartLine;
}

/** A part that does not fit the song, with why in plain words. */
export interface RefusedPart {
  readonly ok: false;
  readonly reason: string;
  /** The part as the one-call proposal it was checked as, for its rejection's report. */
  readonly input: AssistantProposal;
  /** Every reason the validator gave. */
  readonly issues: readonly ProposalIssue[];
}

export type PartResolution = ResolvedPart | RefusedPart;

/**
 * What a part's line says. A part that makes a clip, places one or makes a
 * track is "Kick · 4 bars", "Kick · 4 bars at bar 9" or "Kick · new track":
 * the track, and what it makes of it. Any other part reads as the rows a
 * whole proposal's card lists for it, each control old to new ("Swing 50% →
 * 58%"), or failing that as its command's own summary.
 */
export interface PartLine {
  /** The track's name, or the part's words when it is on no one track. */
  readonly name: string;
  /** Its length ("4 bars"), "new track", or null when there is neither. */
  readonly detail: string | null;
  /** The controls it changes, old to new, when the line is those; else empty. */
  readonly rows: readonly ProposalRow[];
}

/** The line as one string, as it is read aloud and a dependency names it. */
export function partLineText(line: PartLine): string {
  return line.detail ? `${line.name} · ${line.detail}` : line.name;
}

/**
 * Checks one part against `working`, the project it would apply to, and
 * works out what it makes and what its line says. Never throws and never
 * changes `working`.
 */
export function resolvePart(
  working: Project,
  part: AssistantProposalPart,
): PartResolution {
  const input: AssistantProposal = {
    baseRevision: working.metadata.revision,
    toolsetVersion: part.toolsetVersion,
    calls: [part.call],
  };
  const validation = validateProposal(working, input);
  if (!validation.ok) {
    const issues: RejectionIssue[] = validation.issues.map((issue) => ({
      code: issue.code,
      callName: part.call.name,
      path: issue.path ?? null,
      message: issue.message,
    }));
    return {
      ok: false,
      reason:
        rejectionReason(issues) ??
        "This part doesn't fit your song as it is, so it can't be applied.",
      input,
      issues: validation.issues,
    };
  }
  const { proposal } = validation;
  const [command] = proposal.commands;
  const after = applyCommands(working, proposal.commands) ?? working;
  return {
    ok: true,
    proposal,
    command,
    creates: createdIds(working, after),
    line: lineOf(working, after, proposal),
  };
}

/** `project` with `commands` applied as one uncommitted transaction, or null if they do not apply. */
export function applyCommands(
  project: Project,
  commands: readonly RawCommandInput[],
): Project | null {
  if (commands.length === 0) return project;
  const result = executeTransaction(project, commands, {
    actor: "assistant",
    commitRevision: false,
  });
  return result.ok ? result.project : null;
}

/**
 * The earlier parts `command` needs: those that make an ID its payload
 * names. IDs are prefixed and random, so one appearing in the payload is
 * the payload referring to it.
 */
export function partNeeds(
  command: RawCommandInput,
  earlier: readonly { readonly index: number; readonly creates: ReadonlySet<string> }[],
): number[] {
  const payload = JSON.stringify(command.payload);
  return earlier
    .filter((part) => [...part.creates].some((id) => payload.includes(id)))
    .map((part) => part.index);
}

/** "4 bars", "1 bar", "1.5 bars". */
export function barsText(ticks: number): string {
  const bars = Number((ticks / TICKS_PER_BAR).toFixed(2));
  return `${bars} ${bars === 1 ? "bar" : "bars"}`;
}

/**
 * The line for a part, read in the project after it: a clip it makes or
 * places is its track and length, a track it makes is that track, new, and
 * anything else is the command's own summary, as its history entry reads.
 */
function lineOf(before: Project, after: Project, proposal: ValidProposal): PartLine {
  const { impact } = proposal;
  const trackName = (trackId: string) =>
    after.song.tracks.find((track) => track.id === trackId)?.name ?? null;
  const clipId = impact.clips.added[0];
  const clip = clipId && after.clips.find((candidate) => candidate.id === clipId);
  if (clip) {
    const name = trackName(clip.trackId);
    if (name) return { name, detail: barsText(clip.lengthTicks), rows: [] };
  }
  const placementId = impact.placements.added[0];
  const placement =
    placementId &&
    after.song.placements.find((candidate) => candidate.id === placementId);
  if (placement) {
    const name = trackName(placement.trackId);
    if (name) {
      // Where it lands, so it reads apart from the clip it places.
      const bar = Math.floor(placement.startTicks / TICKS_PER_BAR) + 1;
      return {
        name,
        detail: `${barsText(placement.durationTicks)} at bar ${bar}`,
        rows: [],
      };
    }
  }
  const trackId = impact.tracks.added[0];
  const name = trackId ? trackName(trackId) : null;
  if (name) return { name, detail: "new track", rows: [] };
  const rows = proposalRows(before, after, impact.controls);
  if (rows.length > 0) {
    return { name: rows.map(spokenRow).join(", "), detail: null, rows };
  }
  return { name: impact.lines[0]?.summary ?? impact.summary, detail: null, rows: [] };
}

/** A row as it reads aloud: "Swing 50% to 58%", or its label alone. */
function spokenRow(row: ProposalRow): string {
  const from = row.from ?? (row.change === "added" ? "none" : null);
  const to = row.to ?? (row.change === "removed" ? "removed" : null);
  return [row.label, from, from !== null && to !== null ? "to" : null, to]
    .filter((word) => word !== null)
    .join(" ");
}

/** Every ID in `after` that is not in `before`. */
function createdIds(before: Project, after: Project): ReadonlySet<string> {
  const had = new Set(idsOf(before));
  return new Set(idsOf(after).filter((id) => !had.has(id)));
}

function idsOf(project: Project): string[] {
  const { song } = project;
  const devices = (owner: { readonly devices: readonly { readonly id: string }[] }) =>
    owner.devices.map((device) => device.id);
  return [
    ...song.tracks.flatMap((track) => [
      track.id,
      ...devices(track),
      ...(track.instrument?.kind === "drumMachine"
        ? track.instrument.pads.map((pad) => pad.id)
        : []),
    ]),
    ...song.returns.flatMap((bus) => [bus.id, ...devices(bus)]),
    ...devices(song.master),
    ...song.placements.map((placement) => placement.id),
    ...song.sections.map((section) => section.id),
    ...project.clips.flatMap((clip) => [
      clip.id,
      ...(clip.content.kind === "notes"
        ? clip.content.events.map((event) => event.id)
        : []),
    ]),
  ];
}
