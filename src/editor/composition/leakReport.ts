// Audio resources that outlived their project (GRV-55, PRD AUD-09).
//
// Everything the audio engine allocates is registered in the runtime's
// `ResourceRegistry` under its project, and closing the project disposes all
// of it. Anything still registered once that has finished was allocated while
// the project was closing, and nothing will ever dispose it: a leak.
//
// Production reports the leak by kind with its counts in buckets, sampled, to
// error monitoring (`resource_leak`) and analytics (`resources_leaked`). Where
// each resource was allocated is a stack only development and test builds
// record, and it is only ever written to the console there, never sent.

import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import { bucketOf } from "../../analytics/buckets";
import type { RegisteredResourceInfo } from "../../audio/resourceRegistry";
import { CodedError, reportError } from "../../monitoring/errorReporting";

/** The share of leaking closes production reports. */
export const LEAK_SAMPLE_RATE = 0.1;

export interface LeakReportOptions {
  readonly analytics?: Analytics;
  readonly report?: typeof reportError;
  /** Defaults to `Math.random`; tests pin it. */
  readonly random?: () => number;
  /** Defaults to every leak in development and tests, {@link LEAK_SAMPLE_RATE} in production. */
  readonly sampleRate?: number;
  /** Where development builds write the allocation stacks; tests capture it. */
  readonly warn?: (message: string, stacks: readonly string[]) => void;
}

/** Counts `leaked` by the kinds the reports name. */
export function leakCounts(leaked: readonly RegisteredResourceInfo[]): {
  readonly node: number;
  readonly subscription: number;
  readonly other: number;
} {
  let node = 0;
  let subscription = 0;
  let other = 0;
  for (const entry of leaked) {
    if (entry.type === "node") node += 1;
    else if (entry.type === "subscription") subscription += 1;
    else other += 1;
  }
  return { node, subscription, other };
}

/**
 * Reports what a closed project left registered, if anything. Returns whether
 * a report was sent (nothing leaked, or this close was not sampled, is false).
 * Never throws: it runs as a project closes.
 */
export function reportAudioLeaks(
  leaked: readonly RegisteredResourceInfo[],
  options: LeakReportOptions = {},
): boolean {
  if (leaked.length === 0) return false;
  try {
    const counts = leakCounts(leaked);
    if (import.meta.env.DEV) {
      const warn = options.warn ?? ((message, stacks) => console.warn(message, stacks));
      warn(
        `Audio resources outlived their project: ${counts.node} nodes, ${counts.subscription} subscriptions, ${counts.other} other`,
        leaked.flatMap((entry) => (entry.allocatedAt ? [entry.allocatedAt] : [])),
      );
    }
    const sampleRate = options.sampleRate ?? (import.meta.env.DEV ? 1 : LEAK_SAMPLE_RATE);
    if ((options.random ?? Math.random)() >= sampleRate) return false;
    const buckets = {
      node: bucketOf("leak_count", counts.node),
      subscription: bucketOf("leak_count", counts.subscription),
      other: bucketOf("leak_count", counts.other),
    };
    (options.analytics ?? defaultAnalytics).log("resources_leaked", {
      node_count_bucket: buckets.node,
      subscription_count_bucket: buckets.subscription,
      other_count_bucket: buckets.other,
    });
    (options.report ?? reportError)(
      new CodedError("resource_leak", "Audio resources outlived their project"),
      {
        area: "audio",
        fatal: false,
        code: "resource_leak",
        context: {
          leaked_node_bucket: buckets.node,
          leaked_subscription_bucket: buckets.subscription,
          leaked_other_bucket: buckets.other,
        },
      },
    );
    return true;
  } catch {
    return false;
  }
}
