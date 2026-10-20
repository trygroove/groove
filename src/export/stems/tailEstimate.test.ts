import { describe, expect, it } from "vitest";
import { createDevice } from "../../domain/devices";
import type { DeviceId } from "../../domain/ids";
import { deviceTailSeconds } from "./tailEstimate";

const device = (type: "reverb" | "delay" | "filter", parameters = {}) => ({
  ...createDevice("dev_t" as DeviceId, type, 0),
  parameters: { ...createDevice("dev_t" as DeviceId, type, 0).parameters, ...parameters },
});

describe("deviceTailSeconds", () => {
  it("is zero for a device that does not ring and for a bypassed one", () => {
    expect(deviceTailSeconds(device("filter"), 120)).toBe(0);
    expect(deviceTailSeconds({ ...device("reverb"), bypassed: true }, 120)).toBe(0);
  });

  it("rings a reverb for no longer than its impulse", () => {
    const tail = deviceTailSeconds(device("reverb", { decay: 4, size: 0.5 }), 120);
    expect(tail).toBeGreaterThan(1);
    expect(tail).toBeLessThanOrEqual(4 + 0.01 + 0.025 + 0.05);
  });

  it("rings a delay for its repeats, and longer at higher feedback", () => {
    const low = deviceTailSeconds(device("delay", { feedback: 0.3 }), 120);
    const high = deviceTailSeconds(device("delay", { feedback: 0.8 }), 120);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });

  it("is silent when the effect is fully dry", () => {
    expect(deviceTailSeconds(device("reverb", { wet: 0 }), 120)).toBe(0);
    expect(deviceTailSeconds(device("delay", { wet: 0 }), 120)).toBe(0);
  });
});
