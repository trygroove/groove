import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { clickAndFlush } from "../../testing/events";
import LoadRecoveryNotice from "./LoadRecoveryNotice";

describe("LoadRecoveryNotice (#965)", () => {
  afterEach(cleanup);

  it("says how many clips were left out, as a status", () => {
    render(() => <LoadRecoveryNotice droppedPlacements={11} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "This project was closed before its last save finished. 11 clips in the arrangement never saved and were left out. Everything else is here.",
    );
  });

  it("uses the singular for one clip", () => {
    render(() => <LoadRecoveryNotice droppedPlacements={1} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "1 clip in the arrangement never saved and was left out.",
    );
  });

  it("renders nothing after a clean open", () => {
    render(() => <LoadRecoveryNotice droppedPlacements={0} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("goes away when dismissed", () => {
    render(() => <LoadRecoveryNotice droppedPlacements={2} />);

    clickAndFlush(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
