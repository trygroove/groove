import type { FirebaseApp } from "firebase/app";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} from "firebase/functions";
import type { AssistantTurnTransport } from "./assistant/assistantClient";
import { ASSISTANT_CALL_LIMITS, ASSISTANT_CALLABLE_NAME } from "./assistant/config";
import type {
  AssistantStreamChunk,
  AssistantTurnRequest,
  AssistantTurnResult,
} from "./assistant/protocol";
import {
  ASSISTANT_RETENTION_CALLABLE,
  type RetentionRequest,
} from "./assistant/retention";
import type { RetentionCall } from "./assistant/retentionClient";
import { CLOUD_FUNCTIONS_REGION } from "./shared/cloudFunctions";

/**
 * The browser's side of the `assistantTurn` callable (#69, GRV-26): the one
 * place the assistant touches `firebase/functions`, loaded only when the
 * assistant client is first asked for (`assistantClientProvider.ts`).
 * Firebase sends the caller's ID token with every call, which is how the
 * gateway knows who is asking; the reply's chunks arrive on the callable's
 * stream and its result on `data`. Aborting the signal drops the connection,
 * which is what cancels the turn at the gateway.
 *
 * `emulatorHost` is the Functions emulator (`src/devBackend.ts`), or `null`
 * for the real project.
 */
function functionsFor(app: FirebaseApp, emulatorHost: string | null) {
  const functions = getFunctions(app, CLOUD_FUNCTIONS_REGION);
  if (emulatorHost) {
    const [host, port] = emulatorHost.split(":");
    connectFunctionsEmulator(functions, host, Number(port));
  }
  return functions;
}

export function createFirebaseAssistantTransport(
  app: FirebaseApp,
  emulatorHost: string | null,
): AssistantTurnTransport {
  const functions = functionsFor(app, emulatorHost);
  const call = httpsCallable<
    AssistantTurnRequest,
    AssistantTurnResult,
    AssistantStreamChunk
  >(
    functions,
    ASSISTANT_CALLABLE_NAME,
    // The function may run for as long as it is allowed to; the browser waits
    // that long too rather than giving up at the SDK's 70 seconds.
    { timeout: (ASSISTANT_CALL_LIMITS.functionTimeoutSeconds + 10) * 1_000 },
  );
  return async (request, { signal }) => {
    const { stream, data } = await call.stream(request, { signal });
    return { chunks: stream, result: data };
  };
}

/**
 * The browser's side of the `assistantRetention` callable (GRV-8): the
 * account's answer about keeping its conversations.
 */
export function createFirebaseRetentionCall(
  app: FirebaseApp,
  emulatorHost: string | null,
): RetentionCall {
  const call = httpsCallable<RetentionRequest, unknown>(
    functionsFor(app, emulatorHost),
    ASSISTANT_RETENTION_CALLABLE,
  );
  return async (request) => (await call(request)).data;
}
