import { cleanup, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { expectNoContent, recordErrorReports } from "../testing/errorReports";
import { memoryStorage } from "../testing/storage";
import AppErrorFallback from "./AppErrorFallback";

afterEach(() => cleanup());

describe("AppErrorFallback (PRD OPS-03: a boundary is a capture point)", () => {
  it("reports the error once, as fatal, through the application boundary", () => {
    // Fatal because a surface was replaced by a recovery screen — that is
    // what the section 11 crash-free session rate counts.
    const report = vi.fn();
    const error = new Error("boom");
    render(() => <AppErrorFallback error={error} reset={() => {}} report={report} />);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(error, { area: "shell", fatal: true });
  });

  it("attributes the report to the area the boundary guards", () => {
    const report = vi.fn();
    render(() => (
      <AppErrorFallback
        error={new Error("boom")}
        reset={() => {}}
        area="editor"
        report={report}
      />
    ));

    expect(report.mock.calls[0][1]).toMatchObject({ area: "editor" });
  });

  it("still renders the recovery UI when the reporter throws", () => {
    // This is the last screen before a blank page: an exception escaping here
    // is thrown from inside the boundary's own fallback, which no boundary
    // above can recover from.
    render(() => (
      <AppErrorFallback
        error={new Error("boom")}
        reset={() => {}}
        report={() => {
          throw new Error("reporter exploded");
        }}
      />
    ));

    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("offers a retry that clears the boundary", async () => {
    const reset = vi.fn();
    render(() => (
      <AppErrorFallback error={new Error("boom")} reset={reset} report={() => true} />
    ));

    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("shows the user their own unredacted message", () => {
    // It is their browser and their project; only the *transmitted* message
    // is redacted, by the reporting boundary.
    render(() => (
      <AppErrorFallback
        error={new Error("Clip 'Midnight Drive' not found")}
        reset={() => {}}
        report={() => true}
      />
    ));

    expect(screen.getByText(/Midnight Drive/)).toBeInTheDocument();
  });

  it("sends the crash once, fatal and coded, with no project content (GRV-55)", () => {
    const recorded = recordErrorReports();
    const error = new TypeError(
      `Track "Bassline Wobble" of 'Midnight Drive' has no sound at https://storage.example.com/u/abc/Warm%20Pad.wav`,
    );
    render(() => (
      <AppErrorFallback
        error={error}
        reset={() => {}}
        area="editor"
        report={recorded.report}
      />
    ));

    expect(recorded.reports).toHaveLength(1);
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({
      area: "editor",
      error_code: "unknown",
      fatal: true,
    });
    expectNoContent(payload, [
      "Bassline Wobble",
      "Midnight Drive",
      "Warm%20Pad",
      "storage.example.com",
    ]);
    // The producer still sees their own message.
    expect(screen.getByText(/Midnight Drive/)).toBeInTheDocument();
  });

  it("renders a non-error throw without crashing itself", () => {
    render(() => (
      <AppErrorFallback error="a bare string" reset={() => {}} report={() => true} />
    ));

    expect(screen.getByText("a bare string")).toBeInTheDocument();
  });
});

describe("AppErrorFallback's Reload (GRV-55)", () => {
  function setUp(flushWrites: () => Promise<"nothing_queued" | "saved" | "unsaved">) {
    const transport = createRecordingTransport();
    const analytics = new Analytics({
      transport,
      consent: new ConsentStore(memoryStorage()),
      storage: memoryStorage(),
    });
    const reload = vi.fn();
    const flush = vi.fn(flushWrites);
    render(() => (
      <AppErrorFallback
        error={new Error("boom")}
        reset={() => {}}
        report={() => true}
        flushWrites={flush}
        reload={reload}
        analytics={analytics}
      />
    ));
    const reloaded = () => transport.named("crash_reloaded").map((event) => event.params);
    const firstUses = () =>
      transport.named("feature_first_use").map((event) => event.params);
    return { reload, flush, reloaded, firstUses };
  }

  it("says Reload saves first, writes queued edits, then reloads", async () => {
    const { reload, flush, reloaded, firstUses } = setUp(async () => "saved");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reload to carry on. Any change still waiting to save is saved first.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(flush).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(reloaded()).toEqual([expect.objectContaining({ save_outcome: "saved" })]);
    expect(firstUses()).toEqual([expect.objectContaining({ feature: "crash_reload" })]);
  });

  it("reloads straight away when nothing was waiting to save", async () => {
    const { reload, reloaded } = setUp(async () => "nothing_queued");

    await userEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(reload).toHaveBeenCalledOnce();
    expect(reloaded()).toEqual([
      expect.objectContaining({ save_outcome: "nothing_queued" }),
    ]);
  });

  it("does not reload an unsaved edit away: it says so, and offers Reload anyway", async () => {
    const { reload, flush, reloaded, firstUses } = setUp(async () => "unsaved");

    await userEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(reload).not.toHaveBeenCalled();
    expect(reloaded()).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your latest changes couldn't be saved. Check your connection, then press Reload to try again.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(flush).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Reload anyway" }));
    expect(reload).toHaveBeenCalledOnce();
    expect(reloaded()).toEqual([expect.objectContaining({ save_outcome: "unsaved" })]);
    expect(firstUses()).toEqual([expect.objectContaining({ feature: "crash_reload" })]);
  });
});
