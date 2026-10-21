import { describe, expect, it } from "vitest";
import { insertChain, masterChain, returnChain } from "../../commands";
import { createDevice, deviceParameters } from "../../domain/devices";
import type { DeviceId, ReturnId, TrackId } from "../../domain/ids";
import { deviceParameterTarget, readDeviceControl } from "./deviceControlModel";

const deviceId = "dev_1" as DeviceId;

describe("deviceParameterTarget", () => {
  it("addresses a track's insert through trackDevice", () => {
    const trackId = "trk_1" as TrackId;
    expect(deviceParameterTarget(insertChain(trackId), deviceId, "size")).toEqual({
      scope: "trackDevice",
      trackId,
      deviceId,
      parameterId: "size",
    });
  });

  it("addresses the master's device through masterDevice", () => {
    expect(deviceParameterTarget(masterChain, deviceId, "drive")).toEqual({
      scope: "masterDevice",
      deviceId,
      parameterId: "drive",
    });
  });

  it("addresses a return bus's device through returnDevice (#386)", () => {
    const returnId = "ret_1" as ReturnId;
    expect(deviceParameterTarget(returnChain(returnId), deviceId, "size")).toEqual({
      scope: "returnDevice",
      returnId,
      deviceId,
      parameterId: "size",
    });
  });
});

describe("readDeviceControl (#865)", () => {
  const delay = (parameters: Record<string, number>) => {
    const device = createDevice(deviceId, "delay", 0);
    return { ...device, parameters: { ...device.parameters, ...parameters } };
  };
  const definition = (id: string) => {
    const found = deviceParameters("delay").find((d) => d.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  it("reads a synced delay's time from its division and the tempo", () => {
    const reading = readDeviceControl(
      delay({ sync: 1, division: 4, time: 0.25 }),
      definition("delay.time"),
      122,
    );
    expect(reading.derived).toBe(true);
    expect(reading.value).toBeCloseTo((240 / 122) * (1.5 / 8));
  });

  it("reads a free delay's stored time, whatever the tempo", () => {
    expect(
      readDeviceControl(delay({ sync: 0, time: 0.25 }), definition("delay.time"), 90),
    ).toEqual({ value: 0.25, derived: false });
  });

  it("reads every other control as stored", () => {
    expect(
      readDeviceControl(
        delay({ sync: 1, feedback: 0.6 }),
        definition("delay.feedback"),
        90,
      ),
    ).toEqual({ value: 0.6, derived: false });
  });
});
