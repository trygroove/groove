/**
 * The assistant's traces to PostHog's AI Observability (GRV-126, ADR 0011
 * decision 4), over `posthog-node`. The gateway decides what each
 * `$ai_generation` event says (`src/assistant/traces.ts`), and the one
 * `assistant_provider_down` event a provider-level failure sends whatever the
 * producer's consent (GRV-206); this queues them, and sends them when the
 * turn has ended.
 *
 * Sending never delays or fails a turn: `capture` only queues, and `flush`,
 * which the callable runs once the turn is over, gives up after
 * {@link TRACE_FLUSH_TIMEOUT_MS} and never rejects. A PostHog failure is
 * logged as a code only: an error's message could quote what was sent.
 */
import { PostHog } from "posthog-node";
import type {
  AssistantServerEvent,
  AssistantTraceSink,
} from "../../src/assistant/traces";

/** How long a turn's events may hold the callable open once the turn is over. */
export const TRACE_FLUSH_TIMEOUT_MS = 2_000;

/** PostHog's US ingestion host, where Groove's project is. */
export const POSTHOG_US_HOST = "https://us.i.posthog.com";

/** A trace sink the callable flushes before it returns. */
export interface FlushableTraceSink extends AssistantTraceSink {
  /** Sends what is queued. Resolves within the timeout; never rejects. */
  flush(): Promise<void>;
}

/** The slice of `posthog-node` this calls, which is what a test fake implements. */
export interface TraceClient {
  capture(message: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  }): void;
  flush(): Promise<void>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/** What may be logged about a PostHog failure: a code, never a message. */
export type TraceFailure =
  | "capture_failed"
  | "flush_failed"
  | "flush_timeout"
  | "send_failed";

export interface PostHogTracesOptions {
  readonly client: TraceClient;
  readonly onFailure: (failure: TraceFailure) => void;
  readonly timeoutMs?: number;
}

export function createPostHogTraces(options: PostHogTracesOptions): FlushableTraceSink {
  const { client, onFailure } = options;
  const timeoutMs = options.timeoutMs ?? TRACE_FLUSH_TIMEOUT_MS;
  try {
    client.on("error", () => onFailure("send_failed"));
  } catch {
    // Without the listener a failed send goes unlogged; nothing else changes.
  }
  return {
    capture(event: AssistantServerEvent) {
      try {
        client.capture({
          distinctId: event.distinctId,
          event: event.event,
          properties: { ...event.properties },
        });
      } catch {
        onFailure("capture_failed");
      }
    },
    async flush() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      try {
        let sending: Promise<void>;
        try {
          sending = Promise.resolve(client.flush());
        } catch (error) {
          sending = Promise.reject(error);
        }
        const result = await Promise.race([
          sending.then(() => "sent" as const),
          timedOut,
        ]);
        if (result === "timeout") {
          onFailure("flush_timeout");
          // Still settling in the background: its failure is not the turn's.
          sending.catch(() => {});
        }
      } catch {
        onFailure("flush_failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The production client: the project's public key and host, sending only
 * when flushed, with no geolocation (the function's own address would be
 * meaningless) and one retry.
 */
export function createPostHogTraceClient(key: string, host: string): TraceClient {
  return new PostHog(key, {
    host,
    flushAt: 100,
    flushInterval: 0,
    disableGeoip: true,
    fetchRetryCount: 1,
    requestTimeout: TRACE_FLUSH_TIMEOUT_MS,
  });
}
