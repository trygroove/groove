import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import { bucketOf } from "../../analytics/buckets";
import {
  type OfflineRender,
  OfflineRenderError,
  type OfflineRenderOptions,
  renderProjectOffline,
} from "../../audio/offlineRenderer";
import { songEndSeconds } from "../../audio/renderLength";
import { wav24Chunks } from "../../audio/wavEncoder";
import type { Project } from "../../domain/entities";
import { missingSoundsAtStart } from "../../export/missingSounds";
import {
  type AudioSongProjection,
  buildAudioProjection,
} from "../../projection/audioProjection";
import { type Clock, systemClock } from "../../shared/clock";
import { isOutOfMemory } from "../../shared/outOfMemory";
import { exportFileName } from "./exportFileName";

/**
 * Stereo WAV export (EXP-002): renders the whole arrangement offline and
 * encodes it as a 24-bit stereo WAV, reporting the `export_*` trio.
 *
 * It only reads the project: the render builds its own offline graph from the
 * audio projection (EXP-001) and never touches the live context, transport or
 * graph, so an export neither edits the song nor disturbs playback. Its result
 * is all or nothing — the file exists only once the render and the encode have
 * both succeeded, so a cancelled or failed export never hands back a partial
 * file. Gain is the project's own (DEC-004): no normalization anywhere.
 *
 * Memory: a ten-minute song is a few hundred megabytes of float samples. The
 * WAV is encoded a chunk at a time straight into `Blob` parts, so the whole
 * file never exists as one buffer beside those floats, and the finished `Blob`
 * is what the download uses, never a second copy of it. The floats are let go
 * as soon as the last chunk is written.
 */

/** The rate a project renders at when none of its assets declares one: the
 * library's master rate (docs/sample-library.md). */
export const DEFAULT_EXPORT_SAMPLE_RATE = 48_000;

/**
 * The project's sample rate: the highest rate any of its assets was delivered
 * at, so an export never downsamples its own material, or 48 kHz when no asset
 * declares one. It is a property of the project, never of the device playing
 * it, so the same project exports the same file on every machine.
 */
export function projectSampleRate(project: Project): number {
  let rate = 0;
  for (const asset of project.song.assets) {
    if (asset.sampleRate !== null) rate = Math.max(rate, asset.sampleRate);
  }
  return rate > 0 ? rate : DEFAULT_EXPORT_SAMPLE_RATE;
}

export type RenderFunction = (
  projection: AudioSongProjection,
  options: OfflineRenderOptions,
) => Promise<OfflineRender>;

export interface StereoExportOptions {
  /** Aborting it cancels the export; it rejects with code `"aborted"`. */
  readonly signal?: AbortSignal;
  /** Monotonic 0..1 progress. */
  readonly onProgress?: (fraction: number) => void;
  readonly analytics?: Analytics;
  readonly clock?: Clock;
  /** Test seam: the offline renderer. */
  readonly render?: RenderFunction;
  /** Sounds the project reports missing: rendered around if they cannot load (#78). */
  readonly missingAssetIds?: ReadonlySet<string>;
}

export interface StereoExport {
  /** The whole WAV file, `audio/wav`. */
  readonly blob: Blob;
  readonly fileName: string;
  readonly sampleRate: number;
  readonly frames: number;
}

/** Share of the progress bar the render takes; the encode is the rest. */
const RENDERED = 0.95;

/** Encodes `rendered` as a WAV `Blob`, one bounded chunk at a time. */
function encodeToBlob(rendered: OfflineRender): Blob {
  const parts: Blob[] = [];
  for (const chunk of wav24Chunks(rendered.channels, rendered.sampleRate)) {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
  }
  return new Blob(parts, { type: "audio/wav" });
}

/** Why an export failed, as a stable analytics code. */
function failureOf(error: unknown): OfflineRenderError {
  if (error instanceof OfflineRenderError) return error;
  // Encoding holds the whole song in memory once more (GRV-55).
  if (isOutOfMemory(error)) {
    return new OfflineRenderError("out_of_memory", "The export ran out of memory", {
      cause: error,
    });
  }
  // The encoder's only refusal is a render longer than a WAV can describe.
  if (error instanceof RangeError) {
    return new OfflineRenderError("quota_exceeded", "The song is too long to export", {
      cause: error,
    });
  }
  return new OfflineRenderError("internal", "The export failed", { cause: error });
}

/**
 * Exports `project` as a stereo WAV. Resolves with the finished file, or
 * rejects with an {@link OfflineRenderError} whose `code` says why (`"aborted"`
 * when cancelled). Emits `export_started` once, then exactly one of
 * `export_completed` or `export_failed`. File names are never logged.
 */
export async function exportStereoWav(
  project: Project,
  options: StereoExportOptions = {},
): Promise<StereoExport> {
  const analytics = options.analytics ?? defaultAnalytics;
  const clock = options.clock ?? systemClock;
  const render = options.render ?? renderProjectOffline;
  const startedAt = clock.now();
  const projection = buildAudioProjection(project);

  analytics.log("export_started", {
    export_type: "stereo",
    duration_bucket: bucketOf("musical_duration", songEndSeconds(projection)),
    track_count_bucket: bucketOf("track_count", project.song.tracks.length),
    ...missingSoundsAtStart(analytics, project, options.missingAssetIds),
  });
  analytics.logFeatureFirstUse("export_stereo");

  try {
    const sampleRate = projectSampleRate(project);
    let rendered: OfflineRender | null = await render(projection, {
      sampleRate,
      signal: options.signal,
      onProgress: (fraction) => options.onProgress?.(fraction * RENDERED),
      missingAssetIds: options.missingAssetIds,
    });
    if (options.signal?.aborted) throw new OfflineRenderError("aborted", "Cancelled");
    const { frames, sampleRate: renderedRate } = rendered;
    const blob = encodeToBlob(rendered);
    rendered = null;
    if (options.signal?.aborted) throw new OfflineRenderError("aborted", "Cancelled");
    options.onProgress?.(1);
    analytics.log("export_completed", {
      export_type: "stereo",
      elapsed_ms_bucket: bucketOf("elapsed_ms", clock.now() - startedAt),
    });
    return {
      blob,
      fileName: exportFileName(project.metadata.name, new Date(clock.now()), "wav"),
      sampleRate: renderedRate,
      frames,
    };
  } catch (error) {
    const failure = failureOf(error);
    analytics.log("export_failed", {
      export_type: "stereo",
      error_code: failure.code,
      was_cancelled: failure.cancelled,
    });
    throw failure;
  }
}
