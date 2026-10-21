import { cleanup, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionNotice, SessionNoticeListener } from "./EditorSession";
import { noticeMessage, SessionToast } from "./SessionToast";

describe("SessionToast (GRV-88)", () => {
  afterEach(cleanup);

  function renderWithNotices() {
    let emit: SessionNoticeListener = () => {};
    let subscribed = 0;
    render(() => (
      <SessionToast
        onNotice={(listener) => {
          emit = listener;
          subscribed += 1;
          return () => {
            subscribed -= 1;
          };
        }}
      />
    ));
    return {
      notify(notice: SessionNotice) {
        emit(notice);
        flush();
      },
      subscribed: () => subscribed,
    };
  }

  it("shows a refused undo, and replaces it with the next notice", () => {
    const { notify } = renderWithNotices();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    notify({ kind: "undo_refused", direction: "undo" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Can't undo: that changed in another tab.",
    );

    notify({ kind: "edits_discarded", count: 1 });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "A change you made was discarded because the project changed in another tab.",
    );
  });

  it("stops listening when it unmounts", () => {
    const { subscribed } = renderWithNotices();
    expect(subscribed()).toBe(1);
    cleanup();
    expect(subscribed()).toBe(0);
  });

  it("words each notice", () => {
    expect(noticeMessage({ kind: "undo_refused", direction: "redo" })).toBe(
      "Can't redo: that changed in another tab.",
    );
    expect(noticeMessage({ kind: "edits_discarded", count: 3 })).toBe(
      "3 changes you made were discarded because the project changed in another tab.",
    );
  });
});
