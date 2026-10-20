import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveStatus as SaveStatusValue } from "../persistence/autosave";
import type { SaveFailure } from "../persistence/projectRepository";
import { clickAndFlush } from "../testing/events";
import SaveStatus, { OFFLINE_DETAIL } from "./SaveStatus";

function status(overrides: Partial<SaveStatusValue> = {}): SaveStatusValue {
  return {
    state: "saved",
    revision: 3,
    pending: 0,
    lastSavedAt: 1,
    failure: null,
    ...overrides,
  };
}

function failure(reason: SaveFailure["reason"], retryable = true): SaveFailure {
  return { ok: false, reason, message: "backend text", retryable };
}

describe("SaveStatus's failure states (GRV-55)", () => {
  afterEach(cleanup);

  it("says a write the connection dropped is waiting to reconnect, even when the browser claims to be online", () => {
    // QA (GRV-55): DevTools' offline throttling left `navigator.onLine` true,
    // and the failure read "Check your connection." instead.
    const onRetry = vi.fn();
    render(() => (
      <SaveStatus
        saveStatus={() =>
          status({ state: "failed", pending: 1, failure: failure("unavailable") })
        }
        onRetry={onRetry}
        online={() => true}
      />
    ));

    expect(screen.getByText("Save failed")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Offline. Reconnect to save.");
    expect(alert).toHaveAttribute("title", OFFLINE_DETAIL);
    expect(alert).not.toHaveTextContent("backend text");
    clickAndFlush(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("asks the producer to check their connection when a write is refused online", () => {
    render(() => (
      <SaveStatus
        saveStatus={() =>
          status({ state: "failed", pending: 1, failure: failure("unavailable", false) })
        }
        onRetry={() => {}}
        online={() => true}
      />
    ));

    expect(screen.getByRole("alert")).toHaveTextContent("Check your connection.");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("keeps saying it is offline while a retry is in flight, and while an edit waits after it", () => {
    const [value, setValue] = createSignal(
      status({ state: "failed", pending: 1, failure: failure("unavailable") }),
    );
    render(() => (
      <SaveStatus saveStatus={value} onRetry={() => {}} online={() => true} />
    ));

    // A retry clears the autosave's failure while it is in flight.
    setValue(status({ state: "saving", pending: 1 }));
    flush();
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Offline. Reconnect to save.");

    setValue(status({ state: "pending", pending: 1, failure: failure("unavailable") }));
    flush();
    expect(screen.getByText("Offline")).toBeInTheDocument();

    setValue(status({ state: "saved", revision: 4 }));
    flush();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says it is offline and that the changes are kept, while an edit waits", () => {
    render(() => (
      <SaveStatus
        saveStatus={() => status({ state: "pending", pending: 2 })}
        onRetry={() => {}}
        online={() => false}
      />
    ));

    const readout = screen.getByText("Offline");
    expect(readout).toHaveAttribute("title", OFFLINE_DETAIL);
    expect(readout).toHaveAttribute("data-offline", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says a write failed because it is offline, and still offers Retry", () => {
    render(() => (
      <SaveStatus
        saveStatus={() =>
          status({ state: "failed", pending: 1, failure: failure("unavailable") })
        }
        onRetry={() => {}}
        online={() => false}
      />
    ));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Offline. Reconnect to save.");
    expect(alert).toHaveAttribute("title", OFFLINE_DETAIL);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("goes back to Saved once the queued edit is written after reconnecting", () => {
    const [online, setOnline] = createSignal(false);
    const [value, setValue] = createSignal(status({ state: "pending", pending: 1 }));
    render(() => <SaveStatus saveStatus={value} onRetry={() => {}} online={online} />);
    expect(screen.getByText("Offline")).toBeInTheDocument();

    setOnline(true);
    setValue(status({ state: "saved", revision: 4 }));
    flush();

    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("keeps a reason that is not about the connection, offline or not", () => {
    render(() => (
      <SaveStatus
        saveStatus={() =>
          status({
            state: "failed",
            pending: 1,
            failure: failure("document_too_large", false),
          })
        }
        onRetry={() => {}}
        online={() => false}
      />
    ));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This project is too large to save further changes.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
