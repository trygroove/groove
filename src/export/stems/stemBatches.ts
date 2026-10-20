import { RENDER_CHANNELS } from "../../audio/offlineRenderer";
import { wav24ByteLength } from "../../audio/wavEncoder";
import type { Project } from "../../domain/entities";
import type { TrackId } from "../../domain/ids";
import {
  archiveLimitBytes,
  expectedPlanFrames,
  planFrames,
  type StemExportOptions,
} from "./exportStems";
import { stemArchiveBytes } from "./stemArchive";
import { planStems, type StemRender } from "./stemPlan";

/**
 * Splits a stem export into ZIPs that each fit the archive budget (EXP-004).
 *
 * An export over the budget is not refused: its stems are packed, in order,
 * into as many ZIPs as it takes, rendered and downloaded one after another.
 * The order is the reference mix (which mixes the whole selection, so it
 * lives in ZIP 1), then the selected tracks in track order, then the returns.
 * A stem keeps the name and number `planStems` gave it, so files from several
 * ZIPs sort together. A selection within budget is exactly one batch.
 *
 * A single stem heavier than the budget cannot be split: it gets a batch of
 * its own with `fits: false`, and `exportStems` refuses that ZIP with
 * `quota_exceeded`, as it refuses any archive over budget.
 */
export interface StemBatch {
  /** 0-based position; ZIP `index + 1` of `StemBatch[].length`. */
  readonly index: number;
  /** The archive paths this ZIP holds, in packing order. */
  readonly paths: readonly string[];
  readonly hasMix: boolean;
  /** The tracks whose stems it holds, in track order. */
  readonly trackIds: readonly TrackId[];
  /** Every track and return whose stem it holds, in packing order: the rows a
   * track list marks as this ZIP's. */
  readonly rowIds: readonly string[];
  /** An upper bound on the archive, as the single export's estimate: what
   * batching and the budget check. */
  readonly bytes: number;
  /** What the archive is expected to weigh, every stem the song's length:
   * what the dialog shows. */
  readonly expectedBytes: number;
  /** False only for a lone stem that is over the budget by itself. */
  readonly fits: boolean;
}

type PlanOptions = Pick<StemExportOptions, "sampleRate" | "maxTailSeconds" | "maxBytes">;

/** Mix first, then tracks, then returns, which is not the plan's own order. */
function packingOrder(plan: readonly StemRender[]): StemRender[] {
  return [
    ...plan.filter((stem) => stem.kind === "mix"),
    ...plan.filter((stem) => stem.kind !== "mix"),
  ];
}

export function planStemBatches(
  project: Project,
  options: PlanOptions & { readonly trackIds?: readonly TrackId[] },
): StemBatch[] {
  const plan = planStems(project, options.trackIds && new Set(options.trackIds));
  const wav = wav24ByteLength(RENDER_CHANNELS, planFrames(plan, options));
  const expectedWav = wav24ByteLength(
    RENDER_CHANNELS,
    expectedPlanFrames(plan, options.sampleRate, options.maxTailSeconds),
  );
  const limit = archiveLimitBytes(options.maxBytes);
  const groups: StemRender[][] = [];
  for (const stem of packingOrder(plan)) {
    const current = groups[groups.length - 1];
    const paths = current?.map((held) => held.path) ?? [];
    if (current && stemArchiveBytes([...paths, stem.path], wav) <= limit) {
      current.push(stem);
    } else {
      groups.push([stem]);
    }
  }
  return groups.map((stems, index) => {
    const paths = stems.map((stem) => stem.path);
    const bytes = stemArchiveBytes(paths, wav);
    return {
      index,
      paths,
      hasMix: stems.some((stem) => stem.kind === "mix"),
      trackIds: stems.flatMap((stem) =>
        stem.kind === "track" ? [stem.sourceId as TrackId] : [],
      ),
      rowIds: stems.flatMap((stem) => (stem.sourceId ? [stem.sourceId] : [])),
      bytes,
      expectedBytes: stemArchiveBytes(paths, expectedWav),
      fits: bytes <= limit,
    };
  });
}
