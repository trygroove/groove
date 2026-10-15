/**
 * The `assistantTranscriptsAdmin` callable's handler (GRV-98): Firebase's
 * request on one side, `handleTranscriptAdminRequest`
 * (`src/assistant/transcriptAdmin.ts`) on the other. Kept out of `index.ts`
 * so it is tested without deploying anything; the decision, the admin check
 * included, lives in the shared module.
 */
import { logger } from "firebase-functions";
import {
  type CallableRequest,
  type FunctionsErrorCode,
  HttpsError,
} from "firebase-functions/v2/https";
import {
  handleTranscriptAdminRequest,
  TranscriptAdminError,
  type TranscriptAdminErrorCode,
  type TranscriptAdminResponse,
} from "../../src/assistant/transcriptAdmin";
import type { TranscriptStore } from "../../src/assistant/transcripts";
import { describeUnexpectedError } from "./assistantHandler";

const HTTPS_CODES: Record<TranscriptAdminErrorCode, FunctionsErrorCode> = {
  unauthenticated: "unauthenticated",
  not_admin: "permission-denied",
  invalid_request: "invalid-argument",
};

export function createTranscriptAdminHandler(
  store: () => TranscriptStore,
): (request: CallableRequest<unknown>) => Promise<TranscriptAdminResponse> {
  return async (request) => {
    const token = request.auth?.token as { admin?: unknown } | undefined;
    const caller = request.auth ? { admin: token?.admin === true } : null;
    try {
      return await handleTranscriptAdminRequest(store(), caller, request.data);
    } catch (error) {
      if (error instanceof TranscriptAdminError) {
        // The reason only: never what was asked for or what a transcript says.
        logger.info("a transcript read was refused", { reason: error.code });
        throw new HttpsError(HTTPS_CODES[error.code], error.message, {
          code: error.code,
        });
      }
      logger.error(
        "reading assistant transcripts failed unexpectedly",
        describeUnexpectedError(error),
      );
      throw new HttpsError("internal", "Couldn't read the transcripts.");
    }
  };
}
