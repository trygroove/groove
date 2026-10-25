/**
 * What a takes card (GRV-207) shows and hears: each take checked against the
 * song as a proposal of its own, where in the song it starts, the bars a drum
 * pattern's take loops on while it is heard (GRV-213), and the line that says
 * where the card stands. Pure functions of the project and the
 * offer, so the card's words are testable without rendering it.
 */
import { validateProposal } from "../../assistant/proposal";
import type { ProposalTarget } from "../../assistant/proposalExecutor";
import { editsLeaveProposalValid } from "../../assistant/proposalStaleness";
import type { TakePartType } from "../../assistant/protocol";
import { type AssistantTakes, takeProposal } from "../../assistant/takes";
import { type RawCommandInput, setLoopEnabled, setLoopRange } from "../../commands";
import type { Project } from "../../domain/entities";
import { TICKS_PER_BAR, toTicks } from "../../domain/time";
import { projectAfter } from "./proposalCardModel";

/** One take as the card holds it. */
export interface TakeRow {
  readonly label: string;
  /** The commands that write it into the song, or null when it does not fit. */
  readonly commands: readonly RawCommandInput[] | null;
  /** Where in the song it starts playing, in ticks, or null when it adds nothing to play. */
  readonly startTicks: number | null;
  /** Where it stops playing, in ticks, or null with {@link startTicks}. */
  readonly endTicks: number | null;
  /** The name of the track it plays on, or null with {@link startTicks}. */
  readonly trackName: string | null;
  /**
   * For a drum pattern's take (GRV-213): the bars its pattern fills from where
   * it starts, which hearing it loops on. Null for a melodic take, or one
   * that adds nothing to play.
   */
  readonly loop: { readonly startTicks: number; readonly endTicks: number } | null;
}

/** The offer checked against the song. */
export interface CheckedTakes {
  readonly rows: readonly TakeRow[];
  /** The song moved under the offer, so none of it can be heard or picked. */
  readonly stale: boolean;
}

/**
 * Each take validated against `project` as the proposal it would be, with
 * the edits since `baseRevision` judged as a proposal's are (GRV-132). A take
 * that does not fit has no commands; when the song has moved under every
 * take, the offer is stale.
 */
export function checkTakes(
  project: Project,
  takes: AssistantTakes,
  baseRevision: number,
  target?: Pick<ProposalTarget, "commandTypesSince">,
): CheckedTakes {
  let staleCount = 0;
  const rows = takes.takes.map((take, index): TakeRow => {
    const validation = validateProposal(
      project,
      takeProposal(takes, index, baseRevision),
      (base, types) =>
        editsLeaveProposalValid(target?.commandTypesSince?.(base) ?? null, types),
    );
    if (!validation.ok) {
      if (validation.issues.some((issue) => issue.code === "stale_revision")) {
        staleCount += 1;
      }
      return {
        label: take.label,
        commands: null,
        startTicks: null,
        endTicks: null,
        trackName: null,
        loop: null,
      };
    }
    const after = projectAfter(project, validation.proposal);
    const span = takeSpanTicks(project, after);
    return {
      label: take.label,
      commands: validation.proposal.commands,
      startTicks: span?.start ?? null,
      endTicks: span?.end ?? null,
      trackName: span?.trackName ?? null,
      loop: takes.partType === "drums" ? takePatternLoop(project, after) : null,
    };
  });
  return { rows, stale: staleCount > 0 && staleCount === rows.length };
}

/**
 * Where a take starts playing: the earliest placement it adds, or failing
 * that the earliest placement of a clip it adds or changes. Null when it
 * touches nothing that plays, so hearing it plays from where the song is.
 */
export function takeStartTicks(before: Project, after: Project): number | null {
  return takeSpanTicks(before, after)?.start ?? null;
}

/**
 * Where a take plays in the song: from the start {@link takeStartTicks}
 * finds to the end of the last of the same placements, and the track the
 * first of them is on. Null when it touches nothing that plays.
 */
export function takeSpanTicks(
  before: Project,
  after: Project,
): {
  readonly start: number;
  readonly end: number;
  readonly trackName: string | null;
} | null {
  const placed = new Set(before.song.placements.map((placement) => placement.id));
  const clipsBefore = new Map(before.clips.map((clip) => [clip.id, clip]));
  const touched = new Set(
    after.clips
      .filter((clip) => clipsBefore.get(clip.id) !== clip)
      .filter((clip) => JSON.stringify(clipsBefore.get(clip.id)) !== JSON.stringify(clip))
      .map((clip) => clip.id),
  );
  const added = after.song.placements.filter((placement) => !placed.has(placement.id));
  const candidates =
    added.length > 0
      ? added
      : after.song.placements.filter((placement) => touched.has(placement.clipId));
  if (candidates.length === 0) return null;
  const start = Math.min(...candidates.map((placement) => placement.startTicks));
  const first = candidates.find((placement) => placement.startTicks === start);
  const track = after.song.tracks.find((candidate) => candidate.id === first?.trackId);
  return {
    start,
    trackName: track?.name ?? null,
    end: Math.max(
      ...candidates.map((placement) => placement.startTicks + placement.durationTicks),
    ),
  };
}

/**
 * The bars a drum pattern's take loops on while it is heard (GRV-213): from
 * the bar its first placement starts in, for as long as its clip runs (the
 * pattern's length, or the placement's when that is shorter), out to whole
 * bars, as the song's loop must be. Null when it touches nothing that plays.
 */
export function takePatternLoop(
  before: Project,
  after: Project,
): { readonly startTicks: number; readonly endTicks: number } | null {
  const placed = new Set(before.song.placements.map((placement) => placement.id));
  const clipsBefore = new Map(before.clips.map((clip) => [clip.id, clip]));
  const added = after.song.placements.filter((placement) => !placed.has(placement.id));
  const candidates =
    added.length > 0
      ? added
      : after.song.placements.filter((placement) => {
          const clip = after.clips.find((candidate) => candidate.id === placement.clipId);
          return (
            clip !== undefined &&
            JSON.stringify(clipsBefore.get(clip.id)) !== JSON.stringify(clip)
          );
        });
  const first = [...candidates].sort((a, b) => a.startTicks - b.startTicks)[0];
  if (!first) return null;
  const clip = after.clips.find((candidate) => candidate.id === first.clipId);
  const length = Math.min(clip?.lengthTicks ?? first.durationTicks, first.durationTicks);
  const startTicks = Math.floor(first.startTicks / TICKS_PER_BAR) * TICKS_PER_BAR;
  const endTicks = Math.max(
    startTicks + TICKS_PER_BAR,
    Math.ceil((first.startTicks + length) / TICKS_PER_BAR) * TICKS_PER_BAR,
  );
  return { startTicks, endTicks };
}

/**
 * What hearing a take previews: its commands, and for a drum pattern's take
 * the song's loop set on its pattern, so it repeats while heard (GRV-213).
 * The loop is only the preview's: using the take applies its commands alone,
 * and stopping puts the song's own loop back.
 */
export function hearingCommands(row: TakeRow): readonly RawCommandInput[] | null {
  if (!row.commands) return null;
  if (!row.loop) return row.commands;
  return [
    ...row.commands,
    setLoopRange(toTicks(row.loop.startTicks), toTicks(row.loop.endTicks)),
    setLoopEnabled(true),
  ];
}

/**
 * - `choosing`: shown, nothing changed; any take that fits can be heard.
 * - `picked`: one take became a proposal and was applied through it.
 * - `declined`: "None of these"; nothing changed.
 * - `more`: "4 more" asked for a fresh set, which replaces these.
 * - `stale`: the song moved under the takes; only "4 more" or "None" is left.
 * - `invalid`: none of the takes fits the song, or the offer was malformed.
 */
export type TakesCardStatus =
  | "choosing"
  | "picked"
  | "declined"
  | "more"
  | "stale"
  | "invalid";

/** Everything one takes card shows. */
export interface TakesCard {
  readonly status: TakesCardStatus;
  /** The part the takes are of ("Lead melody"), which titles the card. */
  readonly part: string;
  /** Whether the takes are of a melodic part or a drum pattern (GRV-213). */
  readonly partType: TakePartType;
  /** The track the takes play on ("Lead"), or null when none of them fits. */
  readonly trackName: string | null;
  readonly takes: readonly { readonly label: string; readonly fits: boolean }[];
  /** The take being heard in the song, by index, or null. */
  readonly hearing: number | null;
  /** For `picked`: the take picked, by index. */
  readonly picked: number | null;
  /** A one-off note after something could not be done. */
  readonly notice: string | null;
}

/** The line under the card's buttons: where it stands, announced as it changes. */
export function takesStatusText(card: TakesCard): string {
  const say = (() => {
    switch (card.status) {
      case "choosing":
        return card.hearing !== null
          ? card.partType === "drums"
            ? `Hearing take ${card.hearing + 1} on a loop in your song. Nothing changes until you use one.`
            : `Hearing take ${card.hearing + 1} in your song. Nothing changes until you use one.`
          : "Hear each take in your song, then use the one you like. Nothing changes until you do.";
      case "picked":
        return `Using take ${(card.picked ?? 0) + 1}. The others are set aside.`;
      case "declined":
        return "None of these used. Nothing changed.";
      case "more":
        return "Set aside for 4 more takes. Nothing changed.";
      case "stale":
        return "Out of date. The song changed after these were written. 4 more writes new ones.";
      case "invalid":
        return "These takes don't fit your song as it is. Nothing changed.";
    }
  })();
  return card.notice ? `${say} ${card.notice}` : say;
}
