import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { OfflineAudioContext } from "node-web-audio-api";
import { describe, expect, it } from "vitest";
import { renderedChannel } from "./testAudioContext";

// A real collection on demand, so the hazard `renderedChannel` guards against
// shows up every run instead of only when CI happens to GC mid-test.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

async function renderSine(): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 19_200, 48_000);
  const osc = context.createOscillator();
  osc.frequency.value = 220;
  osc.connect(context.destination);
  osc.start(0);
  return renderedChannel(await context.startRendering());
}

describe("renderedChannel (GRV-198)", () => {
  it("keeps a render's samples intact after its buffer is collected and others render", async () => {
    const kept = await renderSine();
    const expected = Float32Array.from(kept);
    for (let i = 0; i < 40; i++) {
      await renderSine();
      gc();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const changed = kept.filter((sample, i) => !Object.is(sample, expected[i])).length;
    expect(changed).toBe(0);
  });
});
