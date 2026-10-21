import { describe, expect, it } from "vitest";
import { ASSISTANT_ERROR_CODES } from "../../assistant/protocol";
import {
  ERROR_HEADING,
  ERROR_REASSURANCE,
  errorCopy,
  errorMessage,
  resetTime,
} from "./assistantErrorCopy";

const NOW = new Date(2030, 0, 10, 9, 30);

describe("the assistant's error copy", () => {
  it("names every gateway failure in its own words", () => {
    const messages = ASSISTANT_ERROR_CODES.map((code) =>
      errorMessage({ code, retryable: false }, NOW, "en-GB"),
    );
    expect(new Set(messages).size).toBe(ASSISTANT_ERROR_CODES.length);
  });

  it("says a provider error is Coproducer being unavailable, never the model refusing (GRV-206)", () => {
    const copy = errorCopy({ code: "provider_error", retryable: false });
    expect(copy.heading).toBe("Coproducer is unavailable right now.");
    expect(copy.message).toBe("");
    expect(`${copy.heading} ${copy.message}`).not.toMatch(/refus|model|request|message/i);
    expect(ERROR_REASSURANCE).toBe("Your song is unchanged, and editing still works.");
  });

  it("keeps the model-refusal wording for the model's own refusal alone (GRV-206)", () => {
    expect(errorCopy({ code: "refused", retryable: false })).toEqual({
      heading: ERROR_HEADING,
      message: "Its model refused the request.",
    });
    const others = ASSISTANT_ERROR_CODES.filter((code) => code !== "refused").map(
      (code) => errorMessage({ code, retryable: false }, NOW, "en-GB"),
    );
    expect(others.join(" ")).not.toMatch(/refused/);
  });

  it("heads every other failure as Coproducer couldn't reply", () => {
    for (const code of ASSISTANT_ERROR_CODES) {
      if (code === "provider_error") continue;
      expect(errorCopy({ code, retryable: false }, NOW, "en-GB").heading).toBe(
        "Coproducer couldn't reply.",
      );
    }
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
      "You've used all your requests to Coproducer for the last 24 hours. The next one frees up at 14:05.",
    );
  });
});
