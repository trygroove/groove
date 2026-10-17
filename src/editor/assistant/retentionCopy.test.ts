import { describe, expect, it } from "vitest";
import { ASSISTANT_DISCLOSURE_VERSION } from "../../assistant/transcripts";
import {
  DISCLOSURE_PARAGRAPHS,
  NOTICE_CHANGE,
  OPTED_OUT_CONFIRMATION,
  RETENTION_SCOPE,
} from "./retentionCopy";

describe("the disclosure's copy (GRV-126)", () => {
  it("says a kept conversation also goes to PostHog, and only with analytics allowed", () => {
    const disclosure = DISCLOSURE_PARAGRAPHS.join(" ");
    expect(disclosure).toContain("PostHog, our analytics service");
    expect(disclosure).toContain("only if you allow product analytics");
    expect(disclosure).toContain("expire under PostHog's data retention");
  });

  it("never promises that turning keeping off deletes everything", () => {
    expect(NOTICE_CHANGE).not.toContain("deletes every conversation");
    expect(NOTICE_CHANGE).toContain("stops new ones going to PostHog");
    expect(RETENTION_SCOPE).toContain("already sent to Anthropic or PostHog");
    expect(OPTED_OUT_CONFIRMATION).toContain("already sent to Anthropic or PostHog");
  });

  it("is a new disclosure, so every earlier answer is asked again", () => {
    // Bumped with this copy: an answer given to version 1 is stale.
    expect(ASSISTANT_DISCLOSURE_VERSION).toBe(2);
  });
});
