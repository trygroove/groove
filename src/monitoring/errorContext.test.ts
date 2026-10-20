import { describe, expect, it } from "vitest";
import { expectNoContent, recordErrorReports } from "../testing/errorReports";
import {
  audioContextStateKey,
  contextTags,
  ERROR_CONTEXT_KEYS,
  type ErrorContext,
} from "./errorContext";
import { CodedError } from "./errorReporting";
import { ALLOWED_TAGS } from "./scrub";

describe("error report context (GRV-55)", () => {
  it("sends every context key as an allowed tag", () => {
    for (const key of ERROR_CONTEXT_KEYS) {
      expect(ALLOWED_TAGS).toContain(key);
    }
  });

  it("keeps declared values", () => {
    expect(
      contextTags({
        online: false,
        retry_count: 3,
        audio_context_state: "suspended",
        export_type: "stems",
        file_size_bucket: "100_500mb",
        zip_count: 2,
        leaked_node_bucket: "1_4",
      }),
    ).toEqual({
      online: false,
      retry_count: 3,
      audio_context_state: "suspended",
      export_type: "stems",
      file_size_bucket: "100_500mb",
      zip_count: 2,
      leaked_node_bucket: "1_4",
    });
  });

  it("drops a value a key does not declare, and a key nothing declares", () => {
    const smuggled = {
      audio_context_state: "My Song",
      file_size_bucket: "https://example.com/kick.wav",
      retry_count: 999,
      zip_count: 1.5,
      track_name: "Lead Vocal",
    } as unknown as ErrorContext;
    expect(contextTags(smuggled)).toEqual({});
  });

  it("narrows an unknown audio context state", () => {
    expect(audioContextStateKey("running")).toBe("running");
    expect(audioContextStateKey("weird")).toBe("uninitialized");
    expect(audioContextStateKey(undefined)).toBe("uninitialized");
  });

  it("reaches the scrubbed Sentry payload as tags, without content", () => {
    const recorded = recordErrorReports();
    recorded.report(new CodedError("render_failed", "Render of My Song failed"), {
      area: "export",
      fatal: false,
      context: { export_type: "stereo", file_size_bucket: "under_10mb" },
    });
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({
      area: "export",
      error_code: "render_failed",
      export_type: "stereo",
      file_size_bucket: "under_10mb",
    });
    expect(recorded.reports[0].context).toEqual({
      export_type: "stereo",
      file_size_bucket: "under_10mb",
    });
    // The message is the caller's; the tags never are.
    expect(JSON.stringify(payload.tags)).not.toContain("My Song");
    expectNoContent({ tags: payload.tags }, ["My Song"]);
  });
});
