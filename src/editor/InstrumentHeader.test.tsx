import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import InstrumentHeader from "./InstrumentHeader";

afterEach(() => cleanup());

const facts = {
  slot: "T01",
  kind: "Drum machine",
  readouts: [
    { label: "Pads", value: "4" },
    { label: "Sample", value: "Tight Studio Snare", masked: true },
  ],
};

describe("InstrumentHeader (#447)", () => {
  it("shows the slot and kind over the name, and each readout under its label", () => {
    render(() => <InstrumentHeader facts={facts} trackName="Drums" />);
    expect(screen.getByText("T01 · Drum machine")).toBeInTheDocument();
    expect(screen.getByText("Drums")).toBeInTheDocument();
    expect(screen.getByText("Pads").nextElementSibling?.textContent).toBe("4");
    // Names the user chose or recorded are masked in replay (ADR 0002).
    expect(screen.getByText("Drums").className).toContain("ph-mask");
    expect(screen.getByText("Tight Studio Snare").className).toContain("ph-mask");
    expect(screen.getByText("4").className).not.toContain("ph-mask");
  });

  it("offers Audition only when the instrument can be heard", () => {
    const run = vi.fn();
    render(() => (
      <InstrumentHeader
        facts={facts}
        trackName="Drums"
        audition={{ label: "Audition pad", run }}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Audition pad" }));
    expect(run).toHaveBeenCalledOnce();
    cleanup();
    render(() => <InstrumentHeader facts={facts} trackName="Drums" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
