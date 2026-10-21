import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { useTrackDrag } from "./useTrackDrag";

describe("useTrackDrag", () => {
  it("does not read the zone until a drag starts", () => {
    // Callers pass a ref declared after the hook runs (ArrangementView's
    // `headerColumnEl`); reading it at setup is a temporal-dead-zone error.
    let reads = 0;
    const dispose = createRoot((dispose) => {
      useTrackDrag({
        axis: "y",
        zone: () => {
          reads += 1;
          throw new ReferenceError("zone read before initialization");
        },
        indexOf: () => 0,
        onDrop: () => {},
      });
      return dispose;
    });
    flush();
    expect(reads).toBe(0);
    dispose();
  });
});
