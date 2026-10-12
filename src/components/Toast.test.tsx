import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickAndFlush } from "../testing/events";
import { TOAST_DURATION_MS, Toast, type ToastMessage } from "./Toast";

function renderToast(initial: ToastMessage | null) {
  const [toast, setToast] = createSignal<ToastMessage | null>(initial);
  const onClose = vi.fn(() => setToast(null));
  render(() => <Toast toast={toast()} onClose={onClose} />);
  return { setToast, onClose };
}

describe("Toast (GRV-88)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows its message as a status", () => {
    renderToast({ message: "Something changed." });
    expect(screen.getByRole("status")).toHaveTextContent("Something changed.");
  });

  it("puts nothing on the page while no toast is showing", () => {
    renderToast(null);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("closes itself after a few seconds", () => {
    vi.useFakeTimers();
    const { onClose } = renderToast({ message: "Something changed." });
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("closes when dismissed", () => {
    const { onClose } = renderToast({ message: "Something changed." });
    clickAndFlush(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows one at a time: a new toast replaces the old and restarts the timer", () => {
    vi.useFakeTimers();
    const { setToast, onClose } = renderToast({ message: "First." });
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1_000);
    setToast({ message: "Second." });
    flush();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Second.");
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
