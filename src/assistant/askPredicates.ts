/**
 * Answering a question by doing (GRV-42): whether the producer has made, in
 * the editor, the change one of an ask's options describes (`doneWhen`).
 *
 * Every predicate is read against two projects: the one the question was
 * asked about, and the one now. It holds when the change has happened since
 * the question was asked, so a value that was already in range, or a track
 * count that has not grown, never answers anything by itself. Pure and
 * domain-only, like the rest of `src/assistant`.
 */
import type { Project, Track } from "../domain/entities";
import type { AskPredicate, AssistantAsk } from "./ask";

function inRange(
  value: number,
  min: number | undefined,
  max: number | undefined,
): boolean {
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

function track(project: Project, trackId: string): Track | undefined {
  return project.song.tracks.find((candidate) => candidate.id === trackId);
}

function matchingTracks(
  project: Project,
  predicate: Extract<AskPredicate, { kind: "trackAdded" }>,
): number {
  return project.song.tracks.filter(
    (candidate) =>
      (predicate.trackType === undefined || candidate.type === predicate.trackType) &&
      (predicate.instrumentKind === undefined ||
        candidate.instrument?.kind === predicate.instrumentKind),
  ).length;
}

function matchingDevices(
  project: Project,
  predicate: Extract<AskPredicate, { kind: "deviceAdded" }>,
): number {
  const tracks =
    predicate.trackId === undefined
      ? project.song.tracks
      : project.song.tracks.filter((candidate) => candidate.id === predicate.trackId);
  return tracks
    .flatMap((candidate) => candidate.devices)
    .filter(
      (device) =>
        predicate.deviceType === undefined || device.type === predicate.deviceType,
    ).length;
}

/** Whether `project` is in the state `predicate` describes, on its own. */
function stateHolds(predicate: AskPredicate, project: Project): boolean {
  switch (predicate.kind) {
    case "tempo":
      return inRange(project.song.tempo, predicate.min, predicate.max);
    case "swing":
      return inRange(project.song.swing, predicate.min, predicate.max);
    case "trackFlag":
      return track(project, predicate.trackId)?.mixer[predicate.flag] === predicate.value;
    case "trackVolume": {
      const found = track(project, predicate.trackId);
      return (
        found !== undefined && inRange(found.mixer.volume, predicate.min, predicate.max)
      );
    }
    case "trackRemoved":
      return track(project, predicate.trackId) === undefined;
    case "trackAdded":
    case "deviceAdded":
      return false;
  }
}

/**
 * Whether the change `predicate` describes has happened between `asked`, the
 * project the question was asked about, and `now`.
 */
export function predicateHolds(
  predicate: AskPredicate,
  asked: Project,
  now: Project,
): boolean {
  switch (predicate.kind) {
    case "trackAdded":
      return matchingTracks(now, predicate) > matchingTracks(asked, predicate);
    case "deviceAdded":
      return matchingDevices(now, predicate) > matchingDevices(asked, predicate);
    default:
      return stateHolds(predicate, now) && !stateHolds(predicate, asked);
  }
}

/**
 * The option one edit answers, or null: the first, in the ask's order, whose
 * change has happened since the question was asked (`asked` to `now`) and
 * that this edit made (`before` to `now`). An edit that leaves the change
 * where something else put it, the assistant's own proposal say, answers
 * nothing.
 */
export function optionDoneByEdit(
  ask: AssistantAsk,
  asked: Project,
  before: Project,
  now: Project,
): number | null {
  if (before === now) return null;
  const index = ask.options.findIndex(
    (option) =>
      option.doneWhen !== undefined &&
      predicateHolds(option.doneWhen, asked, now) &&
      predicateHolds(option.doneWhen, before, now),
  );
  return index === -1 ? null : index;
}
