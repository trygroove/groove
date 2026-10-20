import * as nwaa from "node-web-audio-api";
import {
  type DeclaredLatency,
  DYNAMICS_PRE_DELAY_SECONDS,
  declareDynamicsLookahead,
} from "./latency";
import { installWebAudioTeardownGuard } from "./testAudioTeardown";

/** Frames per Web Audio render quantum. */
const RENDER_QUANTUM = 128;

/**
 * `node-web-audio-api`'s compressor pre-delay: the browsers' 6 ms, rounded up
 * to whole render quanta (384 frames at 48 kHz, where a browser holds 288).
 * Declared for this engine the way the browsers' figure is for theirs (see
 * `latency.ts`), and pinned by `devices/compressor.latency.test.ts`.
 */
export const NODE_WEB_AUDIO_DYNAMICS_LOOKAHEAD: DeclaredLatency = (sampleRate) =>
  Math.ceil((DYNAMICS_PRE_DELAY_SECONDS * sampleRate) / RENDER_QUANTUM) * RENDER_QUANTUM;

/**
 * jsdom has no Web Audio API, so Tone.js cannot render. `node-web-audio-api`
 * provides a real, native (offline-capable) implementation. Installing its
 * classes as globals lets Tone's bundled `standardized-audio-context` build on
 * top of them, so the real ToneInstrument classes render actual audio in tests.
 *
 * Call this once, before importing Tone, to enable offline rendering.
 */
export function installWebAudioGlobals(): void {
  // Native `ended` events from `node-web-audio-api` can fire after jsdom is
  // torn down; guard against that one teardown-race artifact. See
  // `testAudioTeardown.ts`.
  installWebAudioTeardownGuard();
  // Every render in these suites runs on this engine, so latency compensation
  // has to work from its compressor's pre-delay, not a browser's.
  declareDynamicsLookahead(NODE_WEB_AUDIO_DYNAMICS_LOOKAHEAD);

  const classes = [
    "AudioContext",
    "OfflineAudioContext",
    "AudioParam",
    "AudioNode",
    "AudioBuffer",
    "AudioBufferSourceNode",
    "GainNode",
    "OscillatorNode",
    "BiquadFilterNode",
    "AnalyserNode",
    "ConstantSourceNode",
    "AudioWorkletNode",
    "AudioDestinationNode",
  ] as const;

  for (const key of classes) {
    const impl = (nwaa as unknown as Record<string, unknown>)[key];
    if (impl && !(key in globalThis)) {
      (globalThis as Record<string, unknown>)[key] = impl;
    }
  }
}

/**
 * One channel of a rendered buffer, copied out of it.
 *
 * `node-web-audio-api`'s `getChannelData` returns a view onto native memory
 * that does not keep that memory alive: once the buffer (and its offline
 * context) is garbage-collected, the memory is freed and reused, and the view
 * silently reads whatever lands there next. A test that keeps one render's
 * samples while it renders more is reading freed memory as soon as a GC runs,
 * which only happens under load, so it flakes in CI and never locally
 * (GRV-198: a clean render measured as near-silence with isolated spikes).
 * A browser's `getChannelData` is ordinary GC-managed memory, so this is a
 * test-engine hazard only. Copy before the buffer goes out of scope.
 */
export function renderedChannel(
  buffer: { getChannelData(channel: number): Float32Array },
  channel = 0,
): Float32Array {
  return buffer.getChannelData(channel).slice();
}

/** Root-mean-square amplitude of a rendered mono channel — a proxy for output energy. */
export function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length);
}

/**
 * High-frequency energy proxy: RMS of the first difference (discrete
 * derivative) of the signal. The derivative emphasizes rapid sample-to-sample
 * change, so this rises with high-frequency content and is a robust, FFT-free
 * way to detect a lowpass filter opening or closing. Total RMS is a poor
 * discriminator here because a sawtooth's low fundamental dominates its energy
 * regardless of cutoff.
 */
export function hfEnergy(data: Float32Array): number {
  let sum = 0;
  for (let i = 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    sum += d * d;
  }
  return Math.sqrt(sum / Math.max(1, data.length - 1));
}

/** RMS over a sub-window [startFrac, endFrac) of the buffer (fractions of length). */
export function rmsWindow(
  data: Float32Array,
  startFrac: number,
  endFrac: number,
): number {
  const start = Math.floor(data.length * startFrac);
  const end = Math.floor(data.length * endFrac);
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / Math.max(1, end - start));
}
