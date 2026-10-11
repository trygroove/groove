import type { AssistantClient } from "./assistant/assistantClient";
import { createAssistantClient } from "./assistant/assistantClient";
import type { InMemoryTranscriptStore } from "./assistant/inMemoryTranscriptStore";
import {
  type AssistantRetentionClient,
  createRetentionClient,
} from "./assistant/retentionClient";
import { isMockBackend, resolveEmulatorHosts } from "./devBackend";

/**
 * The editor's `AssistantClient` (GRV-26), chosen the way the repository
 * clients choose theirs: the mock backend runs the gateway in the page over
 * the emulator's scripted provider (`src/assistant/localTransport.ts`), and
 * everything else (the emulator included) calls the `assistantTurn`
 * callable. Both are imported dynamically, so neither `firebase/functions`
 * nor the gateway joins a graph that never opens the assistant.
 */
let cached: Promise<AssistantClient> | null = null;
let cachedRetention: Promise<AssistantRetentionClient> | null = null;

/** The mock backend's one transcript store, shared by its gateway and its retention calls. */
const MOCK_UID = "mock-user";
let mockTranscripts: Promise<InMemoryTranscriptStore> | null = null;
function mockTranscriptStore(): Promise<InMemoryTranscriptStore> {
  mockTranscripts ??= import("./assistant/inMemoryTranscriptStore").then((module) =>
    module.createInMemoryTranscriptStore(),
  );
  return mockTranscripts;
}

export function getAssistantClient(): Promise<AssistantClient> {
  if (cached) return cached;
  const pending = createClient();
  cached = pending;
  // A failed load (a chunk that did not arrive, say) must not stick: the
  // next caller tries again rather than inheriting the rejection forever.
  pending.catch(() => {
    if (cached === pending) cached = null;
  });
  return pending;
}

/**
 * The editor's retention client (GRV-8), chosen like the assistant client:
 * the `assistantRetention` callable, or on the mock backend the same logic in
 * the page over the store its gateway keeps transcripts in.
 */
export function getAssistantRetentionClient(): Promise<AssistantRetentionClient> {
  if (cachedRetention) return cachedRetention;
  const pending = createRetention();
  cachedRetention = pending;
  pending.catch(() => {
    if (cachedRetention === pending) cachedRetention = null;
  });
  return pending;
}

async function createRetention(): Promise<AssistantRetentionClient> {
  if (isMockBackend) {
    const [{ handleRetentionRequest }, store] = await Promise.all([
      import("./assistant/retention"),
      mockTranscriptStore(),
    ]);
    return createRetentionClient((request) =>
      handleRetentionRequest(store, MOCK_UID, request, Date.now()),
    );
  }
  const [{ createFirebaseRetentionCall }, { app }] = await Promise.all([
    import("./firebaseAssistantTransport"),
    import("./firebaseConfig"),
  ]);
  return createRetentionClient(
    createFirebaseRetentionCall(app, resolveEmulatorHosts()?.functions ?? null),
  );
}

async function createClient(): Promise<AssistantClient> {
  if (isMockBackend) {
    const [
      { createLocalAssistantTransport },
      { createEmulatorAssistantProvider },
      guards,
      transcripts,
    ] = await Promise.all([
      import("./assistant/localTransport"),
      import("./assistant/emulatorProvider"),
      import("./assistant/inMemoryGuardStores"),
      mockTranscriptStore(),
    ]);
    return createAssistantClient(
      createLocalAssistantTransport(
        {
          provider: createEmulatorAssistantProvider(),
          guards: guards.createInMemoryGuardStores(),
          transcripts,
          log: () => {},
          now: Date.now,
        },
        { uid: MOCK_UID, signInProvider: "google.com" },
      ),
    );
  }
  const [{ createFirebaseAssistantTransport }, { app }] = await Promise.all([
    import("./firebaseAssistantTransport"),
    import("./firebaseConfig"),
  ]);
  return createAssistantClient(
    createFirebaseAssistantTransport(app, resolveEmulatorHosts()?.functions ?? null),
  );
}
