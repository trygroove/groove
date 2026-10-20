import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceTypeDefinition } from "../domain/devices";
import { SYNTH_FILTER_CUTOFF } from "../domain/parameters";
import { formatReadout } from "../domain/valueFormat";
import FillSlider from "./FillSlider";

afterEach(() => cleanup());

/** One slider over a live value, as a panel would hold it. */
function renderSlider(start = 1000) {
  const onInput = vi.fn();
  const onCommit = vi.fn();
  const [value, setValue] = createSignal(start);
  render(() => (
    <FillSlider
      definition={SYNTH_FILTER_CUTOFF}
      value={value()}
      displayValue={formatReadout(SYNTH_FILTER_CUTOFF, value())}
      onInput={(next) => {
        onInput(next);
        setValue(next);
      }}
      onCommit={onCommit}
    />
  ));
  const field = screen.getByLabelText("Cutoff value") as HTMLInputElement;
  return { onInput, onCommit, field };
}

describe("FillSlider value field (#447)", () => {
  it("shows the live value in a field beside the slider", () => {
    const { field } = renderSlider(760);
    expect(field.value).toBe("760 Hz");
    // It is a text field, not a second slider: flows find sliders by name.
    expect(screen.getAllByRole("slider")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Cutoff value" })).toBe(field);
  });

  it("lands a typed value as one input and one commit", () => {
    const { field, onInput, onCommit } = renderSlider();
    field.value = "2.4k";
    fireEvent.change(field);

    expect(onInput).toHaveBeenCalledExactlyOnceWith(2400);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(2400, "release");
    flush();
    expect(field.value).toBe("2.4 kHz");
  });

  it("clamps a typed value into the range, as a drag past the end does", () => {
    const { field, onCommit } = renderSlider();
    field.value = "99k";
    fireEvent.change(field);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(SYNTH_FILTER_CUTOFF.max, "release");
  });

  it("refuses what is not a value and shows the live value again", () => {
    const { field, onInput, onCommit } = renderSlider();
    field.value = "loud";
    fireEvent.change(field);

    expect(onInput).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.value).toBe("1 kHz");
  });

  it("reads a bare time as ms whatever unit the field shows (GRV-59)", () => {
    const time = deviceTypeDefinition("delay")?.parameters.find(
      (p) => p.id === "delay.time",
    );
    if (!time) throw new Error("no delay.time");
    const onCommit = vi.fn();
    const [value, setValue] = createSignal(2);
    render(() => (
      <FillSlider
        definition={time}
        value={value()}
        displayValue={formatReadout(time, value())}
        onInput={setValue}
        onCommit={onCommit}
      />
    ));
    const field = screen.getByLabelText("Time value") as HTMLInputElement;
    expect(field.value).toBe("2 s");

    field.value = "750";
    fireEvent.change(field);
    expect(onCommit).toHaveBeenLastCalledWith(0.75, "release");
    flush();
    expect(field.value).toBe("750 ms");
  });

  it("reads the text with the caller's parser when the slider has its own space", () => {
    const onCommit = vi.fn();
    render(() => (
      <FillSlider
        definition={SYNTH_FILTER_CUTOFF}
        value={0.5}
        displayValue="half"
        range={{ min: 0, max: 1 }}
        parseEntry={(text) => (text === "top" ? 1 : null)}
        onInput={() => {}}
        onCommit={onCommit}
      />
    ));
    const field = screen.getByLabelText("Cutoff value") as HTMLInputElement;
    field.value = "top";
    fireEvent.change(field);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1, "release");
  });
});

describe("FillSlider double-click reset (#536)", () => {
  function renderResettable(props: { range?: boolean; resetValue?: number } = {}) {
    const onInput = vi.fn();
    const onCommit = vi.fn();
    render(() => (
      <FillSlider
        definition={SYNTH_FILTER_CUTOFF}
        value={5000}
        displayValue="5 kHz"
        onInput={onInput}
        onCommit={onCommit}
        range={props.range ? { min: 0, max: 1, step: 0.01 } : undefined}
        resetValue={props.resetValue}
      />
    ));
    return { onInput, onCommit, slider: screen.getByRole("slider") };
  }

  it("reverts to the declared default as one input and one commit", () => {
    const { slider, onInput, onCommit } = renderResettable();
    fireEvent.dblClick(slider);
    expect(onInput).toHaveBeenCalledExactlyOnceWith(SYNTH_FILTER_CUTOFF.defaultValue);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(
      SYNTH_FILTER_CUTOFF.defaultValue,
      "release",
    );
  });

  it("uses resetValue in the slider's own space when it has a range", () => {
    const { slider, onCommit } = renderResettable({ range: true, resetValue: 0.75 });
    fireEvent.dblClick(slider);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.75, "release");
  });

  it("does nothing on a ranged slider that gave no resetValue", () => {
    const { slider, onInput, onCommit } = renderResettable({ range: true });
    fireEvent.dblClick(slider);
    expect(onInput).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("leaves the value field's double-click to select text", () => {
    const { onInput, onCommit } = renderResettable();
    fireEvent.dblClick(screen.getByRole("textbox"));
    expect(onInput).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// GRV-63: one drag or one arrow press commits once, and says which it was.
describe("FillSlider commits", () => {
  const slider = () => screen.getByRole("slider") as HTMLInputElement;
  const move = (value: string) => fireEvent.input(slider(), { target: { value } });

  it("commits a drag once, whichever order the browser ends it in", () => {
    const { onCommit } = renderSlider();
    fireEvent.pointerDown(slider());
    move("2000");
    fireEvent.pointerUp(slider());
    fireEvent.change(slider());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(2000, "release");

    fireEvent.pointerDown(slider());
    move("3000");
    fireEvent.change(slider());
    fireEvent.pointerUp(slider());
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(3000, "release");
  });

  it("commits nothing for a press and release that did not move it", () => {
    const { onCommit } = renderSlider();
    fireEvent.pointerDown(slider());
    fireEvent.pointerUp(slider());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits an arrow press as a nudge", () => {
    const { onCommit } = renderSlider();
    move("1010");
    fireEvent.change(slider());
    move("1020");
    fireEvent.change(slider());
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(1020, "nudge");
  });
});
