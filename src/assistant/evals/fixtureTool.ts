/**
 * The arguments and the printed report of `bun run assistant:fixture`
 * (GRV-109), kept apart from its Firestore reads (`scripts/access/
 * assistantFixture.ts`) so they are tested without a database.
 *
 * The report names what was renamed, from the producer's name to the
 * fixture's. Those names are printed for the person running the tool, on
 * their own terminal, and never written to the fixture.
 */
import type { TranscriptRecord } from "../transcripts";
import { EvalUsageError } from "./cli";
import { FIXTURE_NAME, TS_FIXTURES } from "./namedFixtures";
import type { ScrubResult } from "./scrubFixture";

export const FIXTURE_USAGE =
  "Usage: bun run assistant:fixture -- <projectId> | --turn <turnId> [--name <fixture-id>] [--drop-unresolvable]";

export interface FixtureArgs {
  /** Exactly one of the two is set. */
  readonly projectId: string | null;
  readonly turnId: string | null;
  readonly name: string | null;
  readonly dropUnresolvable: boolean;
}

export function parseFixtureArgs(argv: readonly string[]): FixtureArgs {
  let projectId: string | null = null;
  let turnId: string | null = null;
  let name: string | null = null;
  let dropUnresolvable = false;
  const flagValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new EvalUsageError(`${flag} needs a value. ${FIXTURE_USAGE}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--turn") {
      turnId = flagValue(index, arg);
      index += 1;
    } else if (arg === "--name") {
      name = flagValue(index, arg);
      index += 1;
    } else if (arg === "--drop-unresolvable") {
      dropUnresolvable = true;
    } else if (arg.startsWith("-")) {
      throw new EvalUsageError(`Unknown option ${arg}. ${FIXTURE_USAGE}`);
    } else if (projectId === null) {
      projectId = arg;
    } else {
      throw new EvalUsageError(`One project at a time. ${FIXTURE_USAGE}`);
    }
  }
  if ((projectId === null) === (turnId === null)) {
    throw new EvalUsageError(`Give a project ID or --turn, not both. ${FIXTURE_USAGE}`);
  }
  if (name !== null) checkFixtureName(name);
  return { projectId, turnId, name, dropUnresolvable };
}

/** Refuses a name a fixture cannot have, or one a TypeScript fixture has. */
export function checkFixtureName(name: string): void {
  if (!FIXTURE_NAME.test(name)) {
    throw new EvalUsageError(
      `"${name}" is not a fixture name: lower-case words joined by hyphens`,
    );
  }
  if (Object.hasOwn(TS_FIXTURES, name)) {
    throw new EvalUsageError(`There is already a fixture "${name}"`);
  }
}

/** The first `scrubbed-N` no fixture is called. Never derived from the project. */
export function defaultFixtureName(existing: readonly string[]): string {
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`scrubbed-${n}`)) n += 1;
  return `scrubbed-${n}`;
}

/**
 * What a kept turn says about what to reproduce: how it stopped and what
 * became of its proposal. Never the message, the reply or the history: the
 * request is written by hand.
 */
export function describeTurn(
  record: Pick<
    TranscriptRecord,
    "turnId" | "stopReason" | "outcomes" | "proposal" | "projectRevision"
  >,
  currentRevision: number,
): string[] {
  const lines = [`Turn ${record.turnId}: stopped with ${record.stopReason}.`];
  const calls = record.proposal?.calls.length ?? 0;
  lines.push(
    record.proposal
      ? `It proposed ${calls} tool call${calls === 1 ? "" : "s"}.`
      : "It made no proposal.",
  );
  if (record.outcomes.length === 0) {
    lines.push("Outcome: none recorded.");
  } else {
    for (const outcome of record.outcomes) {
      const codes = [...new Set((outcome.issues ?? []).map((issue) => issue.code))];
      lines.push(
        `Outcome: ${outcome.outcome}${codes.length > 0 ? ` (${codes.join(", ")})` : ""}.`,
      );
    }
  }
  if (currentRevision !== record.projectRevision) {
    lines.push(
      `The project has moved on since this turn (revision ${record.projectRevision} then, ${currentRevision} now): the fixture is its current state, not the one the model saw.`,
    );
  }
  lines.push(
    "The message, reply and history are not copied: write the request yourself.",
  );
  return lines;
}

/** The report of a scrub: what was written, or why nothing was. */
export function formatScrubReport(
  result: ScrubResult,
  fixture: { readonly name: string; readonly path: string },
): string {
  if (!result.ok && result.reason === "unresolvable") {
    return [
      "Refused: these tracks use sounds the factory library does not have (a producer's own, GRV-282):",
      ...result.tracks.map(
        (track) =>
          `  ${track.name}: ${track.assets} sound${track.assets === 1 ? "" : "s"}`,
      ),
      "Pass --drop-unresolvable to leave those tracks out.",
    ].join("\n");
  }
  if (!result.ok) {
    return [
      "The scrubbed project does not parse, so nothing was written:",
      ...result.issues.slice(0, 10).map((issue) => `  ${issue}`),
    ].join("\n");
  }
  const { summary } = result;
  const lines = [
    `Wrote ${fixture.path}`,
    `  ${summary.tracks} tracks, ${summary.clips} clips, ${summary.notes} notes, ${summary.devices} devices`,
  ];
  if (result.droppedTracks.length > 0) {
    lines.push(
      `Dropped ${result.droppedTracks.length} track${result.droppedTracks.length === 1 ? "" : "s"} with sounds outside the factory library:`,
      ...result.droppedTracks.map((name) => `  ${name}`),
    );
  }
  if (result.droppedAssets > 0) {
    lines.push(`Dropped ${result.droppedAssets} non-factory asset(s).`);
  }
  if (result.cleared.length > 0) lines.push(`Cleared: ${result.cleared.join(", ")}.`);
  lines.push(result.renames.length > 0 ? "Renamed:" : "Renamed nothing.");
  for (const rename of result.renames) {
    lines.push(`  ${rename.kind} "${rename.from}" -> "${rename.to}"`);
  }
  lines.push(`Try it: bun run assistant:try -- new ${fixture.name}`);
  return lines.join("\n");
}
