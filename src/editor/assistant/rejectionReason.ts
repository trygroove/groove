/**
 * Why a proposal did not fit, in the producer's words (GRV-98): the invalid
 * card says which change it was, from the validator's issue codes and the
 * tool the failing call named. The issue's message is the kernel's, for the
 * transcript: it is only searched for whether a sound was to blame, never
 * shown.
 *
 * The first issue decides, as the validator reports the earliest problem
 * first. A `stale_revision` has a card of its own (out of date), so it has
 * no reason here.
 */
import type { ProposalIssueCode } from "../../assistant/proposalIssues";

/** One issue, as much of it as the reason reads. */
export interface RejectionIssue {
  readonly code: ProposalIssueCode;
  /** The tool the failing call named (`track_create`), when one call is to blame. */
  readonly callName: string | null;
  /** Where a broken invariant sits (`song.tracks.2.instrument.assetId`). */
  readonly path: string | null;
  readonly message: string | null;
}

/**
 * What a tool changes, as the producer would name it, by the tool's prefix.
 * A tool none of these name is "a change".
 */
const SUBJECTS: readonly (readonly [prefix: string, subject: string])[] = [
  ["track_", "a track"],
  ["clip_", "a clip"],
  ["note_", "a note"],
  ["notes_", "a note"],
  ["placement_", "a clip on the timeline"],
  ["instrument_", "an instrument"],
  ["drum_", "a drum pad"],
  ["device_", "an effect"],
  ["return_", "a return bus"],
  ["send_", "a send"],
  ["section_", "a section"],
  ["parameter_", "a setting"],
  ["asset_", "a sound"],
];

function subjectOf(callName: string | null): string {
  if (!callName) return "a change";
  return SUBJECTS.find(([prefix]) => callName.startsWith(prefix))?.[1] ?? "a change";
}

/** Whether the tool adds something rather than changing what is there. */
function adds(callName: string | null): boolean {
  return callName !== null && /_(create|add|duplicate)$/.test(callName);
}

/** Whether the issue is about a sound: its tool, its path or the kernel's message names an asset. */
function aboutASound(issue: RejectionIssue): boolean {
  return [issue.callName, issue.path, issue.message].some(
    (text) => typeof text === "string" && /asset/i.test(text),
  );
}

const SOUND_MISSING = "The assistant tried to use a sound that isn't in your library.";

/**
 * The sentence the invalid card leads with, or `null` when there is nothing
 * more to say than that it does not fit (no issues, or only a stale one).
 */
export function rejectionReason(issues: readonly RejectionIssue[]): string | null {
  const issue = issues.find((candidate) => candidate.code !== "stale_revision");
  if (!issue) return null;
  const subject = subjectOf(issue.callName);
  switch (issue.code) {
    case "malformed":
      return "The assistant's reply wasn't a change Groove could read.";
    case "too_many_commands":
      return "The assistant tried to make more changes at once than Groove allows.";
    case "toolset_mismatch":
      return "The assistant answered for a different version of Groove.";
    case "unknown_tool":
      return "The assistant tried a kind of change Groove can't make.";
    case "unauthorized":
      return `The assistant tried to change ${subject} in a way it isn't allowed to.`;
    case "invalid_payload":
      // An asset ID the model made up is not even shaped like one.
      if (aboutASound(issue)) return SOUND_MISSING;
      return `The assistant described ${subject} in a way Groove couldn't read.`;
    case "out_of_range":
      return `The assistant tried to push ${subject} past its range.`;
    case "rejected":
    case "invalid_project":
      if (aboutASound(issue)) return SOUND_MISSING;
      if (issue.code === "invalid_project") {
        return `The assistant's change to ${subject} doesn't fit with the rest of your song.`;
      }
      return adds(issue.callName)
        ? `The assistant tried to add ${subject} that doesn't fit your song.`
        : `The assistant tried to change ${subject} that isn't in your song.`;
    case "stale_revision":
      return null;
  }
}
