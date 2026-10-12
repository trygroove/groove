import { describe, expect, it } from "vitest";
import {
  createScriptedAssistantProvider,
  MINIMAL_ASSISTANT_CONTEXT,
  replyEvents,
  toolUseEvents,
} from "../testing/scriptedAssistantProvider";
import { type AssistantCaller, runAssistantTurn } from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import type { AssistantTurnRequest } from "./protocol";
import { handleRetentionRequest, recordOutcome, setRetention } from "./retention";
import {
  ASSISTANT_DISCLOSURE_VERSION,
  type AssistantTurnSession,
  TRANSCRIPT_RETENTION_MS,
  type TranscriptRecord,
  type TranscriptStore,
} from "./transcripts";

/**
 * What the transcript store promises (GRV-8), through the gateway and the
 * retention callable's logic, run against the in-memory store here and the
 * Firestore store in the emulator suite
 * (`tests/emulator/assistantTranscripts.emulator.test.ts`).
 */
export interface TranscriptStoreHarness {
  /** A fresh, empty store. */
  store(): Promise<TranscriptStore>;
  /** Every record the store holds, read past the rules. */
  records(): Promise<TranscriptRecord[]>;
  /** Writes a preference document as-is, past every check. */
  rawPreference(uid: string, value: unknown): Promise<void>;
}

const START = Date.UTC(2026, 9, 9, 12);
const OWNER = "owner-uid";
const OTHER = "other-uid";
const PROJECT = "prj_contractproject000001";

function session(turnId: string, overrides: Partial<AssistantTurnSession> = {}) {
  return {
    conversationId: "conversation-1",
    turnId,
    projectId: PROJECT,
    internal: false,
    ...overrides,
  } satisfies AssistantTurnSession;
}

function request(
  turnId: string,
  text = "Make the bass punchier",
  overrides: Partial<AssistantTurnSession> = {},
): AssistantTurnRequest {
  return {
    projectRevision: 4,
    messages: [{ role: "user", text }],
    context: MINIMAL_ASSISTANT_CONTEXT,
    session: session(turnId, overrides),
  };
}

export function describeTranscriptStoreContract(
  name: string,
  harness: TranscriptStoreHarness,
): void {
  describe(`assistant transcript store contract (${name})`, () => {
    async function setup(replies = 8) {
      const store = await harness.store();
      let now = START;
      const scripts = Array.from({ length: replies }, () =>
        replyEvents(["Here is ", "one idea."]),
      );
      const provider = createScriptedAssistantProvider(scripts);
      const turn = (
        body: AssistantTurnRequest,
        caller: AssistantCaller = { uid: OWNER, signInProvider: "google.com" },
      ) =>
        runAssistantTurn(
          {
            provider,
            guards: createInMemoryGuardStores(),
            log: () => {},
            now: () => now,
            transcripts: store,
          },
          caller,
          body,
          { signal: new AbortController().signal, onChunk: () => {} },
        );
      return {
        store,
        turn,
        advance(ms: number) {
          now += ms;
        },
        at: () => now,
      };
    }

    it("keeps a turn for an account that has not answered (keeping is the default)", async () => {
      const { turn } = await setup();
      const result = await turn(request("turn-0001"));
      expect(result.text).toBe("Here is one idea.");
      expect((await harness.records()).map((record) => record.turnId)).toEqual([
        "turn-0001",
      ]);
    });

    it("keeps a turn's message, reply, project and timestamps once the account says yes", async () => {
      const { store, turn } = await setup();
      await setRetention(store, OWNER, true, START);
      await turn(request("turn-0001"));
      const [record] = await harness.records();
      expect(record).toMatchObject({
        uid: OWNER,
        projectId: PROJECT,
        projectRevision: 4,
        conversationId: "conversation-1",
        turnId: "turn-0001",
        userMessage: "Make the bass punchier",
        reply: "Here is one idea.",
        proposal: null,
        outcomes: [],
        internal: false,
        createdAt: START,
        expiresAt: START + TRANSCRIPT_RETENTION_MS,
      });
      // The project context the provider saw is not part of it.
      expect(record).not.toHaveProperty("context");
    });

    it("keeps the proposal shown and each outcome of it", async () => {
      const store = await harness.store();
      const provider = createScriptedAssistantProvider([
        toolUseEvents("Try this.", [
          { name: "set_track_volume", input: { trackId: "trk_1", value: -6 } },
        ]),
      ]);
      await setRetention(store, OWNER, true, START);
      await runAssistantTurn(
        {
          provider,
          guards: createInMemoryGuardStores(),
          log: () => {},
          now: () => START,
          transcripts: store,
        },
        { uid: OWNER, signInProvider: "google.com" },
        request("turn-0002"),
        { signal: new AbortController().signal, onChunk: () => {} },
      );
      expect(await recordOutcome(store, OWNER, "turn-0002", "applied", START + 1)).toBe(
        true,
      );
      expect(await recordOutcome(store, OWNER, "turn-0002", "undone", START + 2)).toBe(
        true,
      );
      // Another account cannot write to it.
      expect(await recordOutcome(store, OTHER, "turn-0002", "cancelled", START + 3)).toBe(
        false,
      );
      const [record] = await harness.records();
      expect(record?.proposal?.calls).toEqual([
        {
          id: "toolu_1",
          name: "set_track_volume",
          input: { trackId: "trk_1", value: -6 },
        },
      ]);
      expect(record?.outcomes).toEqual([
        { outcome: "applied", at: START + 1 },
        { outcome: "undone", at: START + 2 },
      ]);
    });

    it("marks team and test traffic internal", async () => {
      const { store, turn } = await setup();
      await setRetention(store, OWNER, true, START);
      await turn(request("turn-0003"), {
        uid: OWNER,
        signInProvider: "google.com",
        internalAccount: true,
      });
      await turn(request("turn-0004", "again", { internal: true }));
      const records = await harness.records();
      expect(records.map((record) => record.internal)).toEqual([true, true]);
    });

    it("keeps nothing for an explicit no, at the current disclosure or any other", async () => {
      const { store, turn } = await setup();
      await setRetention(store, OWNER, false, START);
      await turn(request("turn-0005"));
      for (const disclosureVersion of [
        ASSISTANT_DISCLOSURE_VERSION - 1,
        ASSISTANT_DISCLOSURE_VERSION + 1,
      ]) {
        await harness.rawPreference(OWNER, {
          schemaVersion: 1,
          retain: false,
          disclosureVersion,
          answeredAt: START,
        });
        await turn(request(`turn-000${6 + disclosureVersion}`));
      }
      await harness.rawPreference(OWNER, { retain: false });
      await turn(request("turn-0009"));
      expect(await harness.records()).toEqual([]);
    });

    it("keeps a turn for a yes, and for a malformed or stale preference that does not say no", async () => {
      const { store, turn } = await setup();
      await setRetention(store, OWNER, true, START);
      await turn(request("turn-0005"));
      await harness.rawPreference(OWNER, { retain: "no" });
      await turn(request("turn-0006"));
      await harness.rawPreference(OWNER, {
        schemaVersion: 1,
        retain: true,
        disclosureVersion: ASSISTANT_DISCLOSURE_VERSION + 1,
        answeredAt: START,
      });
      await turn(request("turn-0007"));
      expect((await harness.records()).map((record) => record.turnId)).toEqual([
        "turn-0005",
        "turn-0006",
        "turn-0007",
      ]);
    });

    it("keeps nothing that carries a URL or a credential, and answers the turn regardless", async () => {
      const { store, turn } = await setup();
      await setRetention(store, OWNER, true, START);
      const result = await turn(
        request("turn-0008", "Use https://storage.example.com/kick.wav"),
      );
      expect(result.text).toBe("Here is one idea.");
      await turn(request("turn-0009", "my key is sk-ant-api03-abcdef"));
      expect(await harness.records()).toEqual([]);
    });

    it("deletes what was kept when the account opts out, and keeps nothing after, mid-conversation", async () => {
      const { store, turn } = await setup();
      await setRetention(store, OWNER, true, START);
      await setRetention(store, OTHER, true, START);
      await turn(request("turn-0010"));
      await turn(request("turn-0011"), { uid: OTHER, signInProvider: "google.com" });
      expect(await harness.records()).toHaveLength(2);

      await setRetention(store, OWNER, false, START + 1);
      expect((await harness.records()).map((record) => record.uid)).toEqual([OTHER]);

      // The same conversation carries on, and none of it is kept.
      const result = await turn(request("turn-0012", "and the drums?"));
      expect(result.text).toBe("Here is one idea.");
      expect(await recordOutcome(store, OWNER, "turn-0010", "applied", START + 2)).toBe(
        false,
      );
      expect((await harness.records()).map((record) => record.uid)).toEqual([OTHER]);
    });

    it("leaves nothing behind when an opt-out races a turn being kept", async () => {
      const { store, turn } = await setup();
      await setRetention(store, OWNER, true, START);
      await Promise.all([
        turn(request("turn-0013")),
        setRetention(store, OWNER, false, START),
      ]);
      expect(await harness.records()).toEqual([]);
    });

    it("deletes a record once 30 days have passed since its message, and not before", async () => {
      const { store, turn, advance } = await setup();
      await setRetention(store, OWNER, true, START);
      await turn(request("turn-0014"));
      advance(24 * 60 * 60 * 1000);
      await turn(request("turn-0015"));

      expect(await store.deleteExpired(START + TRANSCRIPT_RETENTION_MS - 1)).toBe(0);
      expect(await harness.records()).toHaveLength(2);
      expect(await store.deleteExpired(START + TRANSCRIPT_RETENTION_MS)).toBe(1);
      expect((await harness.records()).map((record) => record.turnId)).toEqual([
        "turn-0015",
      ]);
    });

    it("deletes a project's records with the project, and an account's with the account", async () => {
      const { store, turn } = await setup();
      await setRetention(store, OWNER, true, START);
      await setRetention(store, OTHER, true, START);
      await turn(request("turn-0016"));
      await turn(
        request("turn-0017", "other", { projectId: "prj_another0000000000001" }),
      );
      await turn(request("turn-0018"), { uid: OTHER, signInProvider: "google.com" });

      expect(await store.deleteForProject(PROJECT)).toBe(2);
      expect((await harness.records()).map((record) => record.turnId)).toEqual([
        "turn-0017",
      ]);
      expect(await store.deleteForUser(OWNER)).toBe(1);
      await store.deletePreference(OWNER);
      expect(await harness.records()).toEqual([]);
      expect(await store.preference(OWNER)).toBeNull();
    });

    it("answers the callable: the preference is the account's, and survives being read again", async () => {
      const store = await harness.store();
      expect(await handleRetentionRequest(store, OWNER, { op: "get" }, START)).toEqual({
        preference: null,
        disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
        retentionDays: 30,
      });
      await handleRetentionRequest(
        store,
        OWNER,
        { op: "set", retain: true, disclosureVersion: ASSISTANT_DISCLOSURE_VERSION },
        START,
      );
      // A later session (sign out and in again, the same uid) reads it back.
      const again = await handleRetentionRequest(store, OWNER, { op: "get" }, START + 5);
      expect(again).toMatchObject({ preference: { retain: true, answeredAt: START } });
      // Nobody else's.
      expect(
        await handleRetentionRequest(store, OTHER, { op: "get" }, START),
      ).toMatchObject({ preference: null });
    });
  });
}
