import { createContext, useContext } from "solid-js";
import type { SpectrumReading } from "../../audio/DeviceChain";
import type { DeviceId } from "../../domain/ids";

/**
 * Where a device panel reads the live spectrum of a device's output from (the
 * EQ, LOOP-022): the editor's `useProjectAudio`, provided once around the
 * views, so a panel deep in a chain reaches it without every component between
 * passing it down. A panel outside the editor — a test, say — finds none and
 * simply draws no spectrum.
 */
export interface DeviceSpectrumSource {
  /** Whether the transport plays, reactively: the spectrum only moves then. */
  isPlaying(): boolean;
  /** What is leaving the device now, or `null` when there is nothing to draw. */
  read(deviceId: DeviceId): SpectrumReading | null;
}

export const DeviceSpectrumContext = createContext<DeviceSpectrumSource | null>(null);

/** The editor's spectrum source, or `null` outside the editor. */
export function useDeviceSpectrum(): DeviceSpectrumSource | null {
  return useContext(DeviceSpectrumContext);
}
