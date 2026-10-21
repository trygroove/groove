import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawCommandInput, TransactionResult } from "../../commands";
import type { Track } from "../../domain/entities";
import { createDrumMachineFixtureProject } from "../../domain/fixtures";
import { PAD_DECAY } from "../../domain/parameters";
import PadSound from "./PadSound";

afterEach(() => cleanup());

function renderPad() {
  const project = createDrumMachineFixtureProject();
  const track = project.song.tracks.find(
    (candidate) => candidate.instrument?.kind === "drumMachine",
  ) as Track;
  const pad =
    track.instrument?.kind === "drumMachine" ? track.instrument.pads[0] : undefined;
  if (!pad) throw new Error("expected a pad");
  const dispatch =
    vi.fn<
      (
        commands: RawCommandInput | readonly RawCommandInput[],
      ) => TransactionResult | undefined
    >();
  const onFirstUse = vi.fn();
  const { container } = render(() => (
    <PadSound
      track={track}
      pad={pad}
      asset={project.song.assets.find((asset) => asset.id === pad.assetId)}
      dispatch={dispatch}
      beginGesture={() => undefined}
      onFirstUse={onFirstUse}
    />
  ));
  const surface = container.querySelector(".drag-surface") as HTMLElement;
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 90, right: 300, bottom: 90 }) as DOMRect;
  const press = (x: number) =>
    fireEvent(
      surface,
      new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: 45 }),
    );
  return { pad, dispatch, onFirstUse, press, container };
}

const lastPayload = (dispatch: ReturnType<typeof renderPad>["dispatch"]) =>
  (
    dispatch.mock.calls.at(-1)?.[0] as unknown as { payload: Record<string, unknown> }[]
  )[0].payload;

describe("PadSound (#447)", () => {
  it("gives the pad a fader for each of its five values", () => {
    const { pad, container } = renderPad();
    expect(
      screen.getByRole("heading", { name: `${pad.name} · sound` }),
    ).toBeInTheDocument();
    for (const name of ["Pitch", "Level", "Pan", "Attack", "Decay"]) {
      // The editor is the region named for its pad, so its faders need not be.
      expect(screen.getByRole("slider", { name })).toBeInTheDocument();
    }
    expect(container.querySelectorAll(".drag-handle")).toHaveLength(2);
  });

  it("sets attack from the peak corner and decay from the tail corner", () => {
    const { pad, dispatch, press } = renderPad();
    press(0);
    expect(lastPayload(dispatch)).toMatchObject({
      padId: pad.id,
      parameterId: "pad.attack",
      value: 0,
    });

    // The decay corner sits at the far end for the default (longest) decay.
    press(280);
    const payload = lastPayload(dispatch);
    expect(payload).toMatchObject({ parameterId: "pad.decay" });
    expect(payload.value as number).toBeGreaterThanOrEqual(PAD_DECAY.min);
    expect(payload.value as number).toBeLessThanOrEqual(PAD_DECAY.max);
  });
});
