import type * as Tone from "tone";
import type { ErrorCode } from "../analytics/errorCodes";
import type {
  AudioAssetProjection,
  AudioSongProjection,
} from "../projection/audioProjection";
import { isOutOfMemory } from "../shared/outOfMemory";
import { type Scheduler, timeoutScheduler } from "../shared/scheduler";
import type { AssetBufferLoader } from "./AudioBufferCache";
import type { AudioHost, AudioProjectScope } from "./AudioRuntime";
import { createDeviceNodeFactory } from "./devices";
import type { InstrumentNodeFactory } from "./InstrumentGraph";
import { disposeVoicesFinishedBy } from "./instruments/assetVoice";
import { createOfflineContext, withGlobalContext } from "./offlineClock";
import { type AudioTransport, ProjectAudioGraph } from "./ProjectAudioGraph";
import { ResourceRegistry } from "./resourceRegistry";
import { toneBufferLoader } from "./toneBufferLoader";

/**
 * One offline render's context and the project graph built on it (EXP-001).
 *
 * The graph is the **same** `ProjectAudioGraph` live playback builds, from the
 * same `AudioSongProjection`, with the same device factory; only the host
 * differs — an `OfflineContext`'s destination and transport instead of the
 * live `AudioRuntime`'s. Nothing here reaches the live runtime, its context,
 * its transport or its resource registry.
 */

/** Stereo: the export format, and the width of the master bus. */
export const RENDER_CHANNELS = 2;

/**
 * How far ahead of the offline clock transport events fire: live playback's
 * own default. With none (Tone's offline default), an event fires on the
 * first 128-frame block after its time and a voice's start is clamped to that
 * block, so every note lands up to a block late.
 */
export const OFFLINE_LOOKAHEAD_SECONDS = 0.1;

/** The owner every offline resource registers under. */
export const OFFLINE_OWNER = "offline-render";

/**
 * Why a render did not produce audio. `code` is a stable analytics error code,
 * so an export can report `export_failed` without inspecting messages, and a
 * cancelled render is `"aborted"` — never a failure in disguise.
 */
export class OfflineRenderError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OfflineRenderError";
  }

  get cancelled(): boolean {
    return this.code === "aborted";
  }
}

export const renderCancelled = (): OfflineRenderError =>
  new OfflineRenderError("aborted", "The render was cancelled");

export interface OfflineSessionOptions {
  sampleRate: number;
  /** How long the render runs, in seconds. */
  durationSeconds: number;
  signal?: AbortSignal;
  /** Decodes assets. Production uses Tone's loader; tests inject buffers. */
  bufferLoader?: AssetBufferLoader<Tone.ToneAudioBuffer>;
  /** Where the graph registers its resources; a private registry otherwise. */
  registry?: ResourceRegistry;
  scheduler?: Scheduler;
  /** Test seam: the instrument factory `ProjectAudioGraph` would use. */
  createInstrument?: InstrumentNodeFactory;
  /** Tracks feed only their sends (a return's stem); see `ProjectAudioGraph`. */
  tracksSendOnly?: boolean;
  /**
   * Sounds the project has already reported missing: a personal sound gone
   * from its pack, or a sound in a withdrawn library pack (#78). One of these
   * that cannot load renders as silence rather than failing the render, so a
   * project degrades to its reported state instead of not exporting at all.
   * Any other sound that cannot load still fails it: that is a connection or
   * a corrupt file, not a known gap, and a file missing it would be a lie.
   */
  missingAssetIds?: ReadonlySet<string>;
}

export interface OfflineSession {
  readonly context: Tone.OfflineContext;
  /** Builds and reconciles the graph, with the offline context installed. */
  build(): void;
  /** Waits for every asset and every asynchronously-built device. */
  prepare(): Promise<void>;
  /** The reported-missing sounds that did not load and render as silence. */
  readonly silencedAssetIds: readonly string[];
  /** Tears down the graph and the context. Idempotent. */
  release(): Promise<void>;
}

/**
 * Opens a session. Throws `not_supported` if no offline context can exist,
 * and `out_of_memory` if one this long cannot be allocated.
 */
export function openOfflineSession(
  projection: AudioSongProjection,
  options: OfflineSessionOptions,
): OfflineSession {
  const { sampleRate } = options;
  const scheduler = options.scheduler ?? timeoutScheduler;
  const frames = Math.ceil(options.durationSeconds * sampleRate);
  let context: Tone.OfflineContext;
  try {
    // Native where it can be, so the render can run in step with its clock.
    context = createOfflineContext(RENDER_CHANNELS, frames, sampleRate);
  } catch (error) {
    // A song too long for the memory left is not a browser without offline
    // rendering (GRV-55): the producer can close tabs, not switch browsers.
    if (isOutOfMemory(error)) {
      throw new OfflineRenderError("out_of_memory", "The render ran out of memory", {
        cause: error,
      });
    }
    throw new OfflineRenderError("not_supported", "Offline rendering is unavailable", {
      cause: error,
    });
  }

  const registry = options.registry ?? new ResourceRegistry();
  const scope = openScope(registry);
  const host: AudioHost = {
    getDestination: () => context.destination,
    getSampleRate: () => sampleRate,
    resume: async () => {},
    openProjectScope: () => scope,
  };

  const loads: Promise<unknown>[] = [];
  const baseLoader = options.bufferLoader ?? toneBufferLoader;
  const bufferLoader: AssetBufferLoader<Tone.ToneAudioBuffer> = {
    load(asset) {
      const load = baseLoader.load(asset);
      loads.push(load);
      return load;
    },
  };
  let failedAsset: { asset: AudioAssetProjection; error: unknown } | null = null;
  const silenced = new Set<string>();

  // The factory live playback uses, reading the tempo this render is at.
  const createDeviceNode = createDeviceNodeFactory({
    scope,
    tempo: () => projection.tempo,
  });

  let graph: ProjectAudioGraph | null = null;
  let released = false;

  return {
    context,
    get silencedAssetIds() {
      return [...silenced];
    },
    build() {
      withGlobalContext(context, () => {
        graph = new ProjectAudioGraph(host, OFFLINE_OWNER, {
          transport: offlineTransport(context),
          bufferLoader,
          createInstrument: options.createInstrument,
          createDeviceNode,
          tracksSendOnly: options.tracksSendOnly,
          now: () => context.immediate(),
          onAssetLoadFailure: (asset, error) => {
            if (options.missingAssetIds?.has(asset.id)) silenced.add(asset.id);
            else failedAsset ??= { asset, error };
          },
        });
        graph.reconcile(projection);
        // Only now: built with none, every initial value (the tempo above
        // included) lands at time 0 rather than one look-ahead in.
        context.lookAhead = OFFLINE_LOOKAHEAD_SECONDS;
      });
    },
    async prepare() {
      await untilSettledOrAborted(Promise.allSettled(loads), options.signal);
      // Let the cache install what just decoded.
      await new Promise((resolve) => scheduler.schedule(() => resolve(undefined), 0));
      if (failedAsset) throw assetError(failedAsset.asset, failedAsset.error);
    },
    async release() {
      if (released) return;
      released = true;
      disposeVoicesFinishedBy(context, Number.POSITIVE_INFINITY);
      await graph?.dispose();
      await registry.disposeOwner(OFFLINE_OWNER);
      context.transport.stop();
      context.dispose();
    },
  };
}

function openScope(registry: ResourceRegistry): AudioProjectScope {
  return {
    ownerId: OFFLINE_OWNER,
    register: (type, dispose) => registry.register(OFFLINE_OWNER, type, dispose),
    release: (handle) => registry.disposeOne(handle),
    dispose: async () => {
      await registry.disposeOwner(OFFLINE_OWNER);
    },
  };
}

/** The offline context's own transport, bound explicitly rather than read off
 * the global context the way live playback's is. */
function offlineTransport(context: Tone.OfflineContext): AudioTransport {
  const transport = context.transport;
  return {
    bpm: transport.bpm,
    schedule: (callback, time) => transport.schedule(callback, time),
    clear: (id) => {
      transport.clear(id);
    },
    on: (event, callback) => {
      transport.on(event, callback);
    },
    off: (event, callback) => {
      transport.off(event, callback);
    },
  };
}

/** Waits for `work`, but rejects as cancelled as soon as `signal` aborts, so a
 * hung asset download cannot hold a cancelled render open. */
async function untilSettledOrAborted(
  work: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await work;
    return;
  }
  if (signal.aborted) throw renderCancelled();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(renderCancelled());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function assetError(asset: AudioAssetProjection, error: unknown): OfflineRenderError {
  // An asset id, never its name or URL: this message may reach error reports.
  // With no URL there was nothing public to fetch: a producer's own sound
  // (#282) that cannot be read as the user rendering is missing to them.
  const code: ErrorCode = asset.url ? "decode_failed" : "asset_missing";
  return new OfflineRenderError(code, `Asset ${asset.id} could not be loaded`, {
    cause: error,
  });
}
