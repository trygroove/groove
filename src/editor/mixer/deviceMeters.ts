import { createContext, createStore, useContext } from "solid-js";
import type { DeviceMeterReading } from "../../audio/DeviceChain";
import type { DeviceId } from "../../domain/ids";

/**
 * The editor's metering devices' readouts, reactively (#937): the Limiter's
 * gain reduction and its short-term and integrated loudness.
 *
 * `useProjectAudio` samples every one in its frame loop while the transport
 * plays, the way it samples the track meters, so a faceplate only draws.
 * Stopped, nothing is being reduced and there is no "last three seconds", so
 * those go back to rest; the integrated figure stays, because the end of a
 * play-through is exactly when it is worth reading.
 */
export function createDeviceMeters() {
  const [meters, setMeters] = createStore<Record<string, DeviceMeterReading>>({});
  return {
    meter(deviceId: DeviceId): DeviceMeterReading | null {
      return meters[deviceId] ?? null;
    },
    sample(readings: ReadonlyMap<DeviceId, DeviceMeterReading>): void {
      setMeters((draft) => {
        for (const id of Object.keys(draft)) {
          if (!readings.has(id as DeviceId)) delete draft[id];
        }
        for (const [deviceId, reading] of readings) {
          const current = draft[deviceId];
          if (
            current?.gainReductionDb !== reading.gainReductionDb ||
            current?.shortTermLufs !== reading.shortTermLufs ||
            current?.integratedLufs !== reading.integratedLufs
          ) {
            draft[deviceId] = { ...reading };
          }
        }
      });
    },
    /** The transport stopped: let go of what only means something while playing. */
    rest(): void {
      setMeters((draft) => {
        for (const id of Object.keys(draft)) {
          draft[id] = { ...draft[id], gainReductionDb: 0, shortTermLufs: -Infinity };
        }
      });
    },
    /** A play from the top: the programme starts over. */
    reset(): void {
      setMeters((draft) => {
        for (const id of Object.keys(draft)) delete draft[id];
      });
    },
  };
}

/** Where a device faceplate reads its meters from; `null` outside the editor. */
export type DeviceMeterSource = (deviceId: DeviceId) => DeviceMeterReading | null;

export const DeviceMeterContext = createContext<DeviceMeterSource | null>(null);

/** The editor's meter source, or `null` outside the editor (a test, say). */
export function useDeviceMeters(): DeviceMeterSource | null {
  return useContext(DeviceMeterContext);
}
