/**
 * The assistant callable's handler (#69): Firebase's request and response on
 * one side, `runAssistantTurn` (`src/assistant/gateway.ts`) on the other.
 * Kept out of `index.ts` so it is tested without deploying anything; the
 * decisions all live in the gateway.
 */
import { logger } from "firebase-functions";
import {
  type CallableRequest,
  type CallableResponse,
  type FunctionsErrorCode,
  HttpsError,
} from "firebase-functions/v2/https";
import { type AssistantGatewayDeps, runAssistantTurn } from "../../src/assistant/gateway";
import {
  type AssistantErrorCode,
  AssistantGatewayError,
  type AssistantStreamChunk,
  type AssistantTurnResult,
} from "../../src/assistant/protocol";
import { isInternalAccount } from "../../src/shared/internalTraffic";

/** How each gateway failure reaches the browser. */
const HTTPS_CODES: Record<AssistantErrorCode, FunctionsErrorCode> = {
  unauthenticated: "unauthenticated",
  invalid_request: "invalid-argument",
  timeout: "deadline-exceeded",
  cancelled: "cancelled",
  provider_unavailable: "unavailable",
  provider_error: "failed-precondition",
  malformed_response: "internal",
  reply_too_long: "out-of-range",
  quota_exceeded: "resource-exhausted",
  assistant_disabled: "unavailable",
  spend_ceiling_reached: "unavailable",
};

/**
 * What may be logged about an error the gateway did not expect: its class
 * name and its code, if it has one. Never its message, which could quote the
 * request or the provider.
 */
export function describeUnexpectedError(error: unknown): {
  name: string;
  code: string | null;
} {
  if (!(error instanceof Error)) return { name: typeof error, code: null };
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    code: typeof code === "string" || typeof code === "number" ? String(code) : null,
  };
}

export function toHttpsError(error: AssistantGatewayError): HttpsError {
  return new HttpsError(HTTPS_CODES[error.code], error.message, error.details);
}

/** Everything but the provider is wired here; the provider needs the secret. */
export type AssistantHandlerDeps = Omit<
  AssistantGatewayDeps,
  "log" | "now" | "onTranscript"
> &
  Partial<Pick<AssistantGatewayDeps, "log" | "now" | "onTranscript">>;

export function createAssistantHandler(
  deps: () => AssistantHandlerDeps,
): (
  request: CallableRequest<unknown>,
  response?: CallableResponse<AssistantStreamChunk>,
) => Promise<AssistantTurnResult> {
  return async (request, response) => {
    const token = request.auth?.token as
      | { firebase?: { sign_in_provider?: unknown }; email?: unknown }
      | undefined;
    const signInProvider = token?.firebase?.sign_in_provider;
    try {
      return await runAssistantTurn(
        {
          log: (record) => logger.info("assistant turn", record),
          // A code only: whether the turn was kept, never what it said.
          onTranscript: (write) => logger.info("assistant transcript", { write }),
          now: Date.now,
          ...deps(),
        },
        {
          uid: request.auth?.uid ?? null,
          signInProvider: typeof signInProvider === "string" ? signInProvider : null,
          internalAccount: isInternalAccount(
            typeof token?.email === "string" ? token.email : null,
          ),
        },
        request.data,
        {
          signal: response?.signal ?? new AbortController().signal,
          onChunk: (chunk) => response?.sendChunk(chunk),
        },
      );
    } catch (error) {
      if (error instanceof AssistantGatewayError) throw toHttpsError(error);
      logger.error("assistant turn failed unexpectedly", describeUnexpectedError(error));
      throw new HttpsError("internal", "The assistant failed.");
    }
  };
}
