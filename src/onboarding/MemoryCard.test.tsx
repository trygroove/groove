import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MEMORY } from "../persistence/profileDocuments";
import { clickAndFlush } from "../testing/events";
import { CONSENT_LABEL, MemoryCard } from "./MemoryCard";

afterEach(cleanup);

describe("the saved-to-memory card (GRV-25)", () => {
  it("lists what memory holds, with the share box unticked", () => {
    render(() => (
      <MemoryCard
        memory={{ ...EMPTY_MEMORY, goal: "curious", gear: ["Roland T-8"] }}
        consent={false}
        onConsent={() => {}}
        status="saved"
        onRetry={() => {}}
      />
    ));
    const card = screen.getByRole("region", { name: "Saved to memory" });
    expect(card).toHaveTextContent("GoalJust curious");
    expect(card).toHaveTextContent("GearRoland T-8");
    expect(
      within(card).getByRole("checkbox", { name: new RegExp(CONSENT_LABEL) }),
    ).not.toBeChecked();
  });

  it("hands a tick to its owner", () => {
    const onConsent = vi.fn();
    render(() => (
      <MemoryCard
        memory={EMPTY_MEMORY}
        consent={false}
        onConsent={onConsent}
        status="saved"
        onRetry={() => {}}
      />
    ));
    clickAndFlush(screen.getByRole("checkbox"));
    expect(onConsent).toHaveBeenCalledWith(true);
  });

  it("says when memory could not be saved, and offers to try again", () => {
    const onRetry = vi.fn();
    render(() => (
      <MemoryCard
        memory={EMPTY_MEMORY}
        consent={false}
        onConsent={() => {}}
        status="save_failed"
        onRetry={onRetry}
      />
    ));
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't save to memory.");
    clickAndFlush(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
