/**
 * Keeps the provider's own reason for refusing a call, for the evals only
 * (GRV-147). A refused call reaches the gateway as a `ProviderFailure` with a
 * kind and a status and nothing else, which is right for production, where
 * the message can quote the request. An experiment whose every turn came back
 * "rejected, HTTP 400" could not say whether the request was malformed or the
 * account had hit its limits, so here the API's error body is read off the
 * response, scrubbed, and attached to the failure for the errored turn's line.
 *
 * Nothing here reaches analytics or error reports: the reason lives in the
 * eval's own report and console output.
 */
import { redactText } from "../../monitoring/scrub";
import {
  type AssistantProvider,
  ProviderFailure,
  type ProviderRejection,
} from "../provider";

/**
 * The API's error body (`{ type: "error", error: { type, message } }`) as a
 * scrubbed reason, or `null` for any other body. Quoted text, keys, URLs and
 * paths go (`redactText`), so neither a request's words nor a secret survives.
 */
export function rejectionOf(body: unknown): ProviderRejection | null {
  const error = (body as { error?: { type?: unknown; message?: unknown } } | null)?.error;
  if (typeof error?.type !== "string" || typeof error.message !== "string") return null;
  const type = redactText(error.type);
  const message = redactText(error.message);
  return type === "" || message === "" ? null : { type, message };
}

async function rejectionOfResponse(
  response: Response,
): Promise<ProviderRejection | null> {
  try {
    return rejectionOf(await response.json());
  } catch {
    return null;
  }
}

/**
 * Wraps a provider built over `fetch` so a refused call says why: each call
 * gets its own `fetch`, which reads a failed response's error body (from a
 * clone, so the SDK still reads the original), and a `ProviderFailure` the
 * call throws is thrown again carrying that reason.
 */
export function withProviderReasons(
  create: (fetchImpl: typeof fetch) => AssistantProvider,
  baseFetch: typeof fetch = fetch,
): AssistantProvider {
  return {
    async *stream(request, signal) {
      let reason: ProviderRejection | null = null;
      const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await baseFetch(input, init);
        if (!response.ok) reason = await rejectionOfResponse(response.clone());
        return response;
      }) as typeof fetch;
      try {
        yield* create(recording).stream(request, signal);
      } catch (error) {
        if (
          error instanceof ProviderFailure &&
          error.reason === null &&
          reason !== null
        ) {
          throw new ProviderFailure(error.kind, error.status, {
            outOfCredit: error.outOfCredit,
            reason,
          });
        }
        throw error;
      }
    },
  };
}
