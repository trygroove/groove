import { cleanup, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_PARTS, controlAddress } from "../commands/controlAddress";
import { ControlRegistryContext } from "../controls/control";
import { createControlRegistry } from "../controls/registry";
import { clickAndFlush } from "../testing/events";
import SampleSlot from "./SampleSlot";
import { SampleSlotTargetingContext } from "./sampleSlotTargeting";

afterEach(cleanup);

describe("SampleSlot (#447)", () => {
  it("names the sound it holds, and opens the library when pressed", () => {
    const onBrowse = vi.fn();
    render(() => (
      <SampleSlot label="Sample for Kick" name="Deep Kick" onBrowse={onBrowse} />
    ));
    const slot = screen.getByRole("button", { name: "Sample for Kick" });
    expect(slot).toHaveTextContent("Deep Kick");
    clickAndFlush(slot);
    expect(onBrowse).toHaveBeenCalledOnce();
  });

  it("registers as its pad's sample control, so it can be shown and outlined (GRV-23)", () => {
    const registry = createControlRegistry();
    const address = controlAddress("pad_kick", CONTROL_PARTS.sample);
    render(() => (
      <ControlRegistryContext value={registry}>
        <SampleSlot
          label="Sample for Kick"
          name="Deep Kick"
          control={address}
          onBrowse={() => {}}
        />
      </ControlRegistryContext>
    ));
    flush();
    const slot = screen.getByRole("button", { name: "Sample for Kick" });
    expect(registry.elementsFor(address)).toEqual([slot]);
    registry.setMark(address, "previewed");
    flush();
    expect(slot).toHaveAttribute("data-control-mark", "previewed");
  });

  it("says when it is empty", () => {
    render(() => <SampleSlot label="Sample" name={null} onBrowse={() => {}} />);
    expect(screen.getByRole("button", { name: "Sample" })).toHaveTextContent(
      "No sample loaded",
    );
  });

  it("carries the Library's icon, and says what an empty slot holds", () => {
    render(() => (
      <SampleSlot
        label="Loop for Break"
        name={null}
        placeholder="No loop loaded"
        onBrowse={() => {}}
      />
    ));
    const slot = screen.getByRole("button", { name: "Loop for Break" });
    expect(slot).toHaveTextContent("No loop loaded");
    // It goes to a view now, not a window (UI-002).
    expect(slot).not.toHaveAttribute("aria-haspopup");
    expect(slot.querySelector(".sample-slot-icon svg")).not.toBeNull();
  });

  it("shows the Library's key, and marks the slot the Library is aimed at", () => {
    const targeting = {
      keyLabel: "4",
      isTarget: (slot: { kind: string; padId?: string }) => slot.padId === "pad_a",
    };
    render(() => (
      <SampleSlotTargetingContext value={targeting}>
        <SampleSlot
          label="Sample for A"
          name="Kick"
          slot={{ kind: "pad", padId: "pad_a" }}
          onBrowse={() => {}}
        />
        <SampleSlot
          label="Sample for B"
          name="Snare"
          slot={{ kind: "pad", padId: "pad_b" }}
          onBrowse={() => {}}
        />
      </SampleSlotTargetingContext>
    ));
    const a = screen.getByRole("button", { name: "Sample for A" });
    expect(a).toHaveAttribute("aria-current", "true");
    expect(a).toHaveTextContent("4");
    expect(a.querySelector(".sample-slot-name")).toHaveTextContent(/^Kick$/);
    expect(screen.getByRole("button", { name: "Sample for B" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
