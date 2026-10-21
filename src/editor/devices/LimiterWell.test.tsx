import { cleanup, render, screen } from "@solidjs/testing-library";
import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceMeterReading } from "../../audio/DeviceChain";
import { createDevice } from "../../domain/devices";
import type { DeviceId } from "../../domain/ids";
import { createDeviceMeters, DeviceMeterContext } from "../mixer/deviceMeters";
import LimiterWell, { formatGainReduction, formatLufs } from "./LimiterWell";

afterEach(() => cleanup());

const deviceId = "dev_limiter" as DeviceId;
const device = createDevice(deviceId, "limiter", 0);

function renderWell(initial: DeviceMeterReading | null) {
  const [reading, setReading] = createSignal(initial);
  render(() => (
    <DeviceMeterContext value={(id) => (id === deviceId ? reading() : null)}>
      <LimiterWell device={device} />
    </DeviceMeterContext>
  ));
  const meter = screen.getByRole("meter", { name: "Gain reduction" });
  return { meter, bar: meter.nextElementSibling as HTMLElement, setReading };
}

describe("LimiterWell (#937)", () => {
  it("shows gain reduction as a bar and a figure, and both loudness readouts", () => {
    const { meter, bar } = renderWell({
      gainReductionDb: 6,
      shortTermLufs: -9.04,
      integratedLufs: -11.26,
    });
    expect(meter).toHaveAttribute("value", "6");
    expect(bar.style.height).toBe("25%");
    expect(screen.getByText("GR −6.0 dB")).toBeInTheDocument();
    expect(screen.getByTestId("limiter-short-term")).toHaveTextContent("−9.0");
    expect(screen.getByTestId("limiter-integrated")).toHaveTextContent("−11.3");
  });

  it("follows the readings as they arrive", () => {
    const { bar, setReading } = renderWell(null);
    expect(bar.style.height).toBe("0%");
    setReading({ gainReductionDb: 30, shortTermLufs: -6, integratedLufs: -7 });
    flush();
    // Past its travel, the bar is simply full.
    expect(bar.style.height).toBe("100%");
    expect(screen.getByTestId("limiter-short-term")).toHaveTextContent("−6.0");
  });

  it("rests, with dashes for loudness, outside the editor", () => {
    render(() => <LimiterWell device={device} />);
    expect(screen.getByRole("meter", { name: "Gain reduction" })).toHaveAttribute(
      "value",
      "0",
    );
    expect(screen.getByTestId("limiter-short-term")).toHaveTextContent("–");
    expect(screen.getByTestId("limiter-integrated")).toHaveTextContent("–");
  });

  it("prints its figures the way the faceplate does", () => {
    expect(formatLufs(-Infinity)).toBe("–");
    expect(formatLufs(-14.04)).toBe("−14.0");
    expect(formatLufs(0.04)).toBe("0.0");
    expect(formatGainReduction(0)).toBe("0.0 dB");
    expect(formatGainReduction(2.35)).toBe("−2.4 dB");
  });
});

describe("createDeviceMeters (#937)", () => {
  it("rests when the transport stops, keeping only the integrated figure", () => {
    createRoot((dispose) => {
      const meters = createDeviceMeters();
      meters.sample(
        new Map([
          [deviceId, { gainReductionDb: 3, shortTermLufs: -8, integratedLufs: -10 }],
        ]),
      );
      meters.rest();
      flush();
      expect(meters.meter(deviceId)).toEqual({
        gainReductionDb: 0,
        shortTermLufs: -Infinity,
        integratedLufs: -10,
      });
      meters.reset();
      flush();
      expect(meters.meter(deviceId)).toBeNull();
      dispose();
    });
  });

  it("drops a device that is no longer metered", () => {
    createRoot((dispose) => {
      const meters = createDeviceMeters();
      meters.sample(
        new Map([
          [deviceId, { gainReductionDb: 1, shortTermLufs: -8, integratedLufs: -9 }],
        ]),
      );
      flush();
      expect(meters.meter(deviceId)).not.toBeNull();
      meters.sample(new Map());
      flush();
      expect(meters.meter(deviceId)).toBeNull();
      dispose();
    });
  });
});
