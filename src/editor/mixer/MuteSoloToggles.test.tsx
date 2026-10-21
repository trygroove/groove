import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickAndFlush } from "../../testing/events";
import MuteSoloToggles from "./MuteSoloToggles";

afterEach(cleanup);

describe("MuteSoloToggles (#447)", () => {
  it("names each toggle for what it acts on, and reports which was pressed", () => {
    const onToggle = vi.fn();
    render(() => (
      <MuteSoloToggles name="Kick" muted={true} soloed={false} onToggle={onToggle} />
    ));
    const mute = screen.getByRole("button", { name: "Mute Kick" });
    const solo = screen.getByRole("button", { name: "Solo Kick" });
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(solo).toHaveAttribute("aria-pressed", "false");

    clickAndFlush(solo);
    clickAndFlush(mute);
    expect(onToggle.mock.calls).toEqual([["soloed"], ["muted"]]);
  });
});
