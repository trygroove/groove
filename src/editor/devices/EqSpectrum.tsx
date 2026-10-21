import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onSettled } from "solid-js";
import type { DeviceId } from "../../domain/ids";
import type { DeviceSpectrumSource } from "./deviceSpectrum";
import { spectrumPath } from "./eqCurve";

/** The animation-frame scheduler the spectrum draws on; injectable for tests. */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const browserFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface EqSpectrumProps {
  readonly deviceId: DeviceId;
  readonly source: DeviceSpectrumSource;
  /** The drawing's box, in the well's SVG units. */
  readonly width: number;
  readonly height: number;
  readonly frames?: FrameScheduler;
}

/**
 * The live spectrum behind the EQ's curve (LOOP-022): what is leaving the
 * device, redrawn each frame — but only while the transport plays and the well
 * is on screen. Stopped, scrolled away or in a hidden tab it draws nothing and
 * reads nothing, so an idle EQ costs no frames at all.
 */
export default function EqSpectrum(props: EqSpectrumProps): JSX.Element {
  const [path, setPath] = createSignal("");
  const [onScreen, setOnScreen] = createSignal(true);
  let element: SVGPathElement | undefined;

  onSettled(() => {
    // Without an observer (jsdom) the well counts as on screen.
    if (typeof IntersectionObserver === "undefined" || !element) return;
    const observer = new IntersectionObserver((entries) =>
      setOnScreen(entries.some((entry) => entry.isIntersecting)),
    );
    // The drawing it sits in, not the path itself: a stopped path is `d=""`,
    // which has no box, so it would never be seen to come back on screen.
    observer.observe(element.ownerSVGElement ?? element);
    return () => observer.disconnect();
  });

  createEffect(
    () => ({
      running: props.source.isPlaying() && onScreen(),
      deviceId: props.deviceId,
      source: props.source,
      frames: props.frames ?? browserFrames,
      width: props.width,
      height: props.height,
    }),
    ({ running, deviceId, source, frames, width, height }) => {
      if (!running) {
        setPath("");
        return;
      }
      const draw = () => {
        const reading = source.read(deviceId);
        setPath(reading ? spectrumPath(reading, width, height) : "");
        handle = frames.request(draw);
      };
      let handle = frames.request(draw);
      return () => frames.cancel(handle);
    },
  );

  return <path ref={element} class="eq-spectrum" d={path()} />;
}
