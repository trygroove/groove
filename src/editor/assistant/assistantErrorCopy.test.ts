import { describe, expect, it } from "vitest";
import { ASSISTANT_ERROR_CODES } from "../../assistant/protocol";
import { errorMessage, resetTime } from "./assistantErrorCopy";

const NOW = new Date(2030, 0, 10, 9, 30);

describe("the assistant's error copy", () => {
  it("names every gateway failure in its own words", () => {
    const messages = ASSISTANT_ERROR_CODES.map((code) =>
      errorMessage({ code, retryable: false }, NOW, "en-GB"),
    );
    expect(new Set(messages).size).toBe(ASSISTANT_ERROR_CODES.length);
  });

  it("says when a quota resets: today, tomorrow, or on its date", () => {
    expect(resetTime(new Date(2030, 0, 10, 14, 5).getTime(), NOW, "en-GB")).toBe(
      "at 14:05",
    );
    expect(resetTime(new Date(2030, 0, 11, 8, 0).getTime(), NOW, "en-GB")).toBe(
      "tomorrow at 08:00",
    );
    expect(resetTime(new Date(2030, 0, 13, 8, 0).getTime(), NOW, "en-GB")).toBe(
      "on 13 Jan at 08:00",
    );
    expect(
      errorMessage(
        {
          code: "quota_exceeded",
          retryable: false,
          resetsAt: new Date(2030, 0, 10, 14, 5).getTime(),
        },
        NOW,
        "en-GB",
      ),
    ).toBe(
      "You've used all your requests to Cue for the last 24 hours. The next one frees up at 14:05.",
    );
  });
});
