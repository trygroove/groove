import { describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import type { RegisteredResourceInfo } from "../audio/resourceRegistry";
import { expectNoContent, recordErrorReports } from "../testing/errorReports";
import { memoryStorage } from "../testing/storage";
import { leakCounts, reportAudioLeaks } from "./leakReport";

const OWNER = "prj_midnightdrive0000000";

function leaked(...types: RegisteredResourceInfo["type"][]): RegisteredResourceInfo[] {
  return types.map((type, index) => ({
    id: index + 1,
    owner: OWNER,
    type,
    allocatedAt: `Error: ${type} owned by "${OWNER}"\n    at TrackAudioGraph (Midnight Drive.ts:1:1)`,
  }));
}

function setUp() {
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  const recorded = recordErrorReports();
  const warn = vi.fn();
  return { transport, analytics, recorded, warn };
}

describe("reportAudioLeaks (GRV-55)", () => {
  it("counts nodes, subscriptions and everything else", () => {
    expect(
      leakCounts(leaked("node", "node", "subscription", "schedule", "buffer")),
    ).toEqual({
      node: 2,
      subscription: 1,
      other: 2,
    });
  });

  it("reports nothing when nothing leaked", () => {
    const { analytics, recorded } = setUp();
    expect(
      reportAudioLeaks([], { analytics, report: recorded.report, sampleRate: 1 }),
    ).toBe(false);
    expect(recorded.reports).toHaveLength(0);
  });

  it("sends one scrubbed resource_leak event and one resources_leaked, by kind in buckets", () => {
    const { transport, analytics, recorded, warn } = setUp();
    const sent = reportAudioLeaks(leaked("node", "node", "subscription"), {
      analytics,
      report: recorded.report,
      sampleRate: 1,
      random: () => 0.5,
      warn,
    });

    expect(sent).toBe(true);
    expect(recorded.reports).toHaveLength(1);
    const [payload] = recorded.payloads();
    expect(payload.tags).toMatchObject({
      area: "audio",
      error_code: "resource_leak",
      fatal: false,
      leaked_node_bucket: "1_4",
      leaked_subscription_bucket: "1_4",
      leaked_other_bucket: "0",
    });
    // The allocation stacks never leave the browser.
    expectNoContent(payload, ["Midnight Drive", "TrackAudioGraph", OWNER]);
    const events = transport.named("resources_leaked");
    expect(events).toHaveLength(1);
    expect(events[0]?.params).toMatchObject({
      node_count_bucket: "1_4",
      subscription_count_bucket: "1_4",
      other_count_bucket: "0",
    });
  });

  it("is sampled", () => {
    const { transport, analytics, recorded, warn } = setUp();
    const sent = reportAudioLeaks(leaked("node"), {
      analytics,
      report: recorded.report,
      sampleRate: 0.1,
      random: () => 0.5,
      warn,
    });
    expect(sent).toBe(false);
    expect(recorded.reports).toHaveLength(0);
    expect(transport.named("resources_leaked")).toHaveLength(0);
  });

  it("writes the allocation stacks to the console in development and tests", () => {
    const { analytics, recorded, warn } = setUp();
    reportAudioLeaks(leaked("node"), {
      analytics,
      report: recorded.report,
      sampleRate: 0,
      warn,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toEqual([expect.stringContaining("TrackAudioGraph")]);
  });
});
