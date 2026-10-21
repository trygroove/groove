/**
 * Lengthening a clip to hold the notes a proposal writes into it (GRV-116).
 *
 * Every note of a clip starts before the clip's length, so a proposal that
 * writes four bars of notes into a one-bar clip leaves the project invalid
 * and the browser refuses it whole. The model is told each placed clip's
 * length (`clipLengthTicks`), and still does it: asked to rework the kick of
 * a starter project, whose one-bar clip loops over four bars, it rewrites
 * the four bars without lengthening the clip. The producer only gets a card
 * that cannot be applied.
 *
 * So the proposal lengthens the clip itself, as `notes.duplicate` does: a
 * clip a proposal makes takes the next listed clip length that holds its own
 * notes, and an existing clip gets a `clip.update` to that length, after the
 * last command that writes or sizes it, which the producer sees as its own
 * line in the proposal. A clip only ever grows, and one whose notes would
 * need more than the longest clip is left as proposed, to be refused.
 */
import type { ClipUpdatePayload } from "../commands/definitions/clips";
import { clipUpdateCommand, updateClip } from "../commands/definitions/clips";
import type { NoteAddPayload, NoteUpdatePayload } from "../commands/definitions/notes";
import type { TrackCreatePayload } from "../commands/definitions/tracks";
import type { RawCommandInput } from "../commands/types";
import { nextClipLengthTicks } from "../domain/clipLength";
import type { Clip, Project } from "../domain/entities";
import type { ClipId } from "../domain/ids";

/** The commands with the clips lengthened, and the command each came from. */
export interface FittedCommands {
  readonly commands: readonly RawCommandInput[];
  /** For each command, the index of the proposed command it is or follows. */
  readonly sourceOf: readonly number[];
}

/** The latest a note of `clip` starts, plus one: the length that holds it. */
function neededBy(clip: Clip): number {
  if (clip.content.kind !== "notes") return 0;
  return Math.max(0, ...clip.content.events.map((event) => event.startTicks + 1));
}

/** `clip` long enough to hold its own notes, or as it was. */
function fitted(clip: Clip): Clip {
  const needed = neededBy(clip);
  if (needed <= clip.lengthTicks) return clip;
  const lengthTicks = nextClipLengthTicks(needed);
  return lengthTicks === null ? clip : { ...clip, lengthTicks };
}

/**
 * `commands`, valid tool calls already resolved against `project`, with
 * every clip lengthened to hold the notes they write into it. Commands that
 * already fit come back as they were.
 */
export function fitClipsToNotes(
  project: Project,
  commands: readonly RawCommandInput[],
): FittedCommands {
  const lengths = new Map<string, number>(
    project.clips.map((clip) => [clip.id, clip.lengthTicks]),
  );
  /** The length each clip's proposed notes need, and the last command that writes or sizes it. */
  const needs = new Map<string, number>();
  const lastAt = new Map<string, number>();
  const need = (clipId: string, ticks: number, index: number) => {
    needs.set(clipId, Math.max(needs.get(clipId) ?? 0, ticks));
    lastAt.set(clipId, index);
  };

  const rewritten = commands.map((command, index): RawCommandInput => {
    switch (command.type) {
      case "clip.create": {
        const payload = command.payload as { clip: Clip };
        const clip = fitted(payload.clip);
        lengths.set(clip.id, clip.lengthTicks);
        lastAt.set(clip.id, index);
        return clip === payload.clip
          ? command
          : { ...command, payload: { ...payload, clip } };
      }
      case "track.create": {
        const payload = command.payload as TrackCreatePayload;
        const clips = payload.clips.map(fitted);
        for (const clip of clips) {
          lengths.set(clip.id, clip.lengthTicks);
          lastAt.set(clip.id, index);
        }
        return clips.every((clip, at) => clip === payload.clips[at])
          ? command
          : { ...command, payload: { ...payload, clips } };
      }
      case "clip.update": {
        const { clipId, changes } = command.payload as ClipUpdatePayload;
        if (changes.lengthTicks !== undefined) {
          lengths.set(clipId, changes.lengthTicks);
          lastAt.set(clipId, index);
        }
        return command;
      }
      case "clip.delete": {
        const { clipId } = command.payload as { clipId: string };
        lengths.delete(clipId);
        needs.delete(clipId);
        return command;
      }
      case "note.add": {
        const { clipId, notes } = command.payload as NoteAddPayload;
        need(clipId, Math.max(...notes.map((note) => note.startTicks + 1)), index);
        return command;
      }
      case "note.update": {
        const { clipId, updates } = command.payload as NoteUpdatePayload;
        const starts = updates.flatMap(({ changes }) =>
          changes.startTicks === undefined ? [] : [changes.startTicks + 1],
        );
        if (starts.length > 0) need(clipId, Math.max(...starts), index);
        return command;
      }
      default:
        return command;
    }
  });

  /** The `clip.update`s to add, by the index of the command they follow. */
  const after = new Map<number, RawCommandInput[]>();
  for (const [clipId, needed] of needs) {
    const length = lengths.get(clipId);
    if (length === undefined || needed <= length) continue;
    const lengthTicks = nextClipLengthTicks(needed);
    if (lengthTicks === null) continue;
    const index = lastAt.get(clipId) ?? commands.length - 1;
    const lengthen = {
      ...updateClip(clipId as ClipId, { lengthTicks }),
      version: clipUpdateCommand.version,
    };
    after.set(index, [...(after.get(index) ?? []), lengthen]);
  }

  const fittedCommands: RawCommandInput[] = [];
  const sourceOf: number[] = [];
  rewritten.forEach((command, index) => {
    for (const next of [command, ...(after.get(index) ?? [])]) {
      fittedCommands.push(next);
      sourceOf.push(index);
    }
  });
  return { commands: fittedCommands, sourceOf };
}
