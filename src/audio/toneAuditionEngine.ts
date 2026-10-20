import * as Tone from "tone";
import {
  AuditionError,
  type PreviewEngine,
  type PreviewStartOptions,
  type PreviewVoice,
} from "../library/audition";
import type { LibraryAsset } from "../library/manifest";
import type { AudioHost, AudioProjectScope } from "./AudioRuntime";
import { playAudioLoop } from "./audioLoopPlayer";
import { StoredAudioUnavailableError } from "./storedAudio";
import { decodeStoredAudio } from "./toneBufferLoader";

/**
 * The Tone-backed {@link PreviewEngine} the browser uses in production.
 *
 * It plays a preview through the runtime's **shared destination** — the same
 * output the project plays through — so audition is heard exactly like the
 * project and is provably not part of any export/offline render (LIB-01:
 * "Audition ... does not become part of export"). Every node it builds is
 * registered with its own runtime project scope (`library-audition`), so
 * disposing the engine tears down its scope idempotently without touching the
 * project graph or the shared context (PRD AUD-07/AUD-09).
 *
 * Lives in `src/audio` with the rest of the Tone code: like `toneBufferLoader.ts`,
 * it keeps the audition *policy* (`AuditionController`) Web-Audio-free and
 * testable, and confines the Web Audio calls to this one file.
 */
export interface ToneAuditionEngineOptions {
  /**
   * The open project's tempo, in BPM. A tempo-labelled loop auditions at this
   * tempo, time-stretched with its pitch intact (INS-02); without it a loop
   * plays at the tempo it was authored at.
   */
  readonly songTempo?: () => number;
}

export class ToneAuditionEngine implements PreviewEngine {
  private readonly scope: AudioProjectScope;
  private disposed = false;

  constructor(
    private readonly runtime: AudioHost,
    private readonly options: ToneAuditionEngineOptions = {},
  ) {
    this.scope = runtime.openProjectScope("library-audition");
  }

  async start(asset: LibraryAsset, options: PreviewStartOptions): Promise<PreviewVoice> {
    if (this.disposed) {
      throw new AuditionError("asset_missing", "Audition engine is disposed");
    }
    const buffer = asset.url ? await this.load(asset.url) : await this.loadStored(asset);
    if (this.disposed) {
      buffer.dispose();
      throw new AuditionError("asset_missing", "Audition engine is disposed");
    }
    if (!isAudible(buffer)) {
      // A zero-length or all-zero decode would "play" and be heard as nothing,
      // with no error anywhere. Report it as the failed load it is (#330).
      buffer.dispose();
      throw new AuditionError("decode_failed", `Asset "${asset.id}" decoded to silence`);
    }

    const player = this.startPlayer(buffer, asset, options);
    const handle = this.scope.register("node", () => {
      if (!player.disposed) player.dispose();
      buffer.dispose();
    });

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          player.stop();
        } catch {
          // A player that has already stopped (or disposed itself) throws on
          // stop; releasing the scope handle disposes whatever is left.
        }
        void this.scope.release(handle);
      },
    };
  }

  /**
   * Start the voice. A one-shot fires immediately, which is what a producer
   * expects when they click a hit. A loop goes through `playAudioLoop` — the
   * same path arrangement playback uses — so it follows the project tempo by
   * time-stretching (INS-02). It drops in on the next bar when the transport is
   * running (LIB-01 "in sync where appropriate") and starts now when it is not:
   * a start scheduled on a stopped transport never fires, which is what made
   * every loop audition silent (#330).
   */
  private startPlayer(
    buffer: Tone.ToneAudioBuffer,
    asset: LibraryAsset,
    options: PreviewStartOptions,
  ): Tone.Player | Tone.GrainPlayer {
    const destination = this.runtime.getDestination();
    if (!options.sync) {
      const player = new Tone.Player(buffer).connect(destination);
      player.start();
      return player;
    }
    const transport = Tone.getTransport();
    const playbackRate = loopPlaybackRate(asset.bpm, this.options.songTempo?.());
    const player = playAudioLoop(buffer, {
      destination,
      time: transport.state === "started" ? transport.nextSubdivision("1m") : Tone.now(),
      durationSeconds: buffer.duration / playbackRate,
      playbackRate,
      offsetSeconds: 0,
    });
    if (!player) {
      throw new AuditionError("decode_failed", `Asset "${asset.id}" has no duration`);
    }
    return player;
  }

  private async load(url: string): Promise<Tone.ToneAudioBuffer> {
    try {
      return await new Promise<Tone.ToneAudioBuffer>((resolve, reject) => {
        const buffer: Tone.ToneAudioBuffer = new Tone.ToneAudioBuffer(
          url,
          () => resolve(buffer),
          (error) =>
            reject(
              new AuditionError(
                "decode_failed",
                error instanceof Error ? error.message : "Decode failed",
              ),
            ),
        );
      });
    } catch (error) {
      if (error instanceof AuditionError) throw error;
      throw new AuditionError(
        "network",
        error instanceof Error ? error.message : "Failed to load asset",
      );
    }
  }

  /**
   * A producer's own sound (#282): no URL, its bytes read from where it is
   * stored as the signed-in user. Not readable is missing; read but not
   * decodable is a decode failure.
   */
  private async loadStored(asset: LibraryAsset): Promise<Tone.ToneAudioBuffer> {
    if (asset.storageRef === undefined) {
      throw new AuditionError("asset_missing", `Asset "${asset.id}" has no audio`);
    }
    try {
      return await decodeStoredAudio(asset.storageRef);
    } catch (error) {
      throw new AuditionError(
        error instanceof StoredAudioUnavailableError ? "asset_missing" : "decode_failed",
        error instanceof Error ? error.message : "Failed to load asset",
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.scope.dispose();
  }
}

/** Song tempo over the loop's authored tempo; 1 when either is unknown. */
function loopPlaybackRate(
  sourceTempo: number | null,
  songTempo: number | undefined,
): number {
  if (!sourceTempo || sourceTempo <= 0 || !songTempo || songTempo <= 0) return 1;
  const rate = songTempo / sourceTempo;
  return Number.isFinite(rate) ? rate : 1;
}

/** Whether a decoded buffer holds any sound at all. */
function isAudible(buffer: Tone.ToneAudioBuffer): boolean {
  if (buffer.length === 0) return false;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] !== 0) return true;
    }
  }
  return false;
}
