import { describe, expect, it } from "vitest";
import {
  createScriptedAssistantProvider,
  MINIMAL_ASSISTANT_CONTEXT,
  replyEvents,
  toolUseEvents,
} from "../testing/scriptedAssistantProvider";
import { ASSISTANT_LIMITS } from "./config";
import { runAssistantTurn } from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import { createInMemoryTranscriptStore } from "./inMemoryTranscriptStore";
import type { AssistantTurnRequest } from "./protocol";
import { recordTurn, setRetention } from "./retention";
import {
  ASSISTANT_DISCLOSURE_VERSION,
  type CompletedTurn,
  checkTranscriptRecord,
  permitsRetention,
  TRANSCRIPT_RETENTION_DAYS,
  TRANSCRIPT_RETENTION_MS,
  transcriptRecordFor,
} from "./transcripts";

const AT = Date.UTC(2026, 9, 9);

const TURN: CompletedTurn = {
  uid: "owner-uid",
  session: {
    conversationId: "conversation-1",
    turnId: "turn-0001",
    projectId: "prj_one",
    internal: false,
  },
  internalAccount: false,
  projectRevision: 3,
  userMessage: "Make it groove",
  reply: "Try swing.",
  stopReason: "end_turn",
  proposal: null,
  model: "claude-sonnet-5",
  promptVersion: "1",
  receivedAt: AT,
};

const RECORD = transcriptRecordFor(TURN);

describe("the retention window", () => {
  it("is the one configured value, 30 days, and every record's expiry reads it", () => {
    expect(TRANSCRIPT_RETENTION_DAYS).toBe(ASSISTANT_LIMITS.transcriptRetentionDays);
    expect(TRANSCRIPT_RETENTION_DAYS).toBe(30);
    expect(RECORD.expiresAt - RECORD.createdAt).toBe(TRANSCRIPT_RETENTION_MS);
  });
});

describe("checkTranscriptRecord", () => {
  it("accepts a well-formed record", () => {
    expect(checkTranscriptRecord(RECORD).ok).toBe(true);
  });

  const refused: [string, unknown][] = [
    [
      "the project context (song content)",
      { ...RECORD, context: MINIMAL_ASSISTANT_CONTEXT },
    ],
    ["a song", { ...RECORD, song: { tracks: [] } }],
    ["clip content", { ...RECORD, clips: [{ id: "clp_1", notes: [] }] }],
    ["audio", { ...RECORD, audio: "UklGRiQAAABXQVZF" }],
    [
      "audio inside a proposal",
      {
        ...RECORD,
        proposal: {
          baseRevision: 3,
          toolsetVersion: 1,
          calls: [{ id: "t", name: "x", input: { audio: [0.1, 0.2] } }],
        },
      },
    ],
    [
      "an asset URL in a message",
      { ...RECORD, userMessage: "use https://cdn.example/kick.wav" },
    ],
    ["a storage URL", { ...RECORD, reply: "gs://bucket/users/u/packs/p/a.wav" }],
    [
      "an asset URL inside a proposal",
      {
        ...RECORD,
        proposal: {
          baseRevision: 3,
          toolsetVersion: 1,
          calls: [{ id: "t", name: "x", input: { assetUrl: "x" } }],
        },
      },
    ],
    ["a provider key", { ...RECORD, userMessage: "sk-ant-api03-AbCdEf123" }],
    [
      "an ID token",
      { ...RECORD, reply: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sig" },
    ],
    ["a bearer token", { ...RECORD, reply: "Bearer abcdefghijklmnopqrstuvwxyz" }],
    ["a token field", { ...RECORD, token: "abc" }],
    ["an expiry that is not the window", { ...RECORD, expiresAt: RECORD.createdAt + 1 }],
  ];
  for (const [what, record] of refused) {
    it(`refuses a record carrying ${what}`, () => {
      expect(checkTranscriptRecord(record).ok).toBe(false);
    });
  }
});

describe("permitsRetention", () => {
  const yes = {
    schemaVersion: 1,
    retain: true,
    disclosureVersion: ASSISTANT_DISCLOSURE_VERSION,
    answeredAt: AT,
  };
  it("permits only a current, well-formed yes", () => {
    expect(permitsRetention(yes)).toBe(true);
    expect(permitsRetention(null)).toBe(false);
    expect(permitsRetention(undefined)).toBe(false);
    expect(permitsRetention({ ...yes, retain: false })).toBe(false);
    expect(permitsRetention({ ...yes, retain: "true" })).toBe(false);
    expect(
      permitsRetention({ ...yes, disclosureVersion: ASSISTANT_DISCLOSURE_VERSION + 1 }),
    ).toBe(false);
    expect(permitsRetention({ ...yes, extra: 1 })).toBe(false);
  });
});

describe("recordTurn", () => {
  it("keeps nothing when the preference cannot be read", async () => {
    const store = createInMemoryTranscriptStore();
    await setRetention(store, TURN.uid, true, AT);
    store.failPreferenceReads(true);
    expect(await recordTurn(store, TURN)).toBe("failed");
    store.failPreferenceReads(false);
    expect(store.records()).toEqual([]);
  });

  it("refuses a turn that carries something forbidden before touching the store", async () => {
    const store = createInMemoryTranscriptStore();
    await setRetention(store, TURN.uid, true, AT);
    expect(
      await recordTurn(store, { ...TURN, userMessage: "see https://example.com/a.wav" }),
    ).toBe("refused");
    expect(await recordTurn(store, TURN)).toBe("kept");
    expect(store.records()).toHaveLength(1);
  });
});

describe("the assistant with retention on, off, or never answered", () => {
  /**
   * The stand-in for running GRV-6's evaluation set with retention disabled
   * (that harness calls the provider directly, bypassing the gateway, so
   * retention cannot reach it): every kind of turn the gateway answers gives
   * the same reply, the same proposal and the same provider request whatever
   * the account said.
   */
  async function run(retain: boolean | null) {
    const store = createInMemoryTranscriptStore();
    if (retain !== null) await setRetention(store, "owner-uid", retain, AT);
    const provider = createScriptedAssistantProvider([
      replyEvents(["Here is ", "one idea."]),
      toolUseEvents("Try this.", [
        { name: "set_track_volume", input: { trackId: "trk_1", value: -6 } },
      ]),
      replyEvents(["Refused."], { stopReason: "refusal" }),
    ]);
    const results = [];
    for (const [index, text] of ["hello", "turn it down", "do something odd"].entries()) {
      const request: AssistantTurnRequest = {
        projectRevision: 2,
        messages: [{ role: "user", text }],
        context: MINIMAL_ASSISTANT_CONTEXT,
        session: {
          conversationId: "conversation-1",
          turnId: `turn-000${index}`,
          projectId: "prj_one",
          internal: false,
        },
      };
      results.push(
        await runAssistantTurn(
          {
            provider,
            guards: createInMemoryGuardStores(),
            log: () => {},
            now: () => AT,
            transcripts: store,
            // Fixed, so each run's requests can be compared whole.
            idStem: () => "Stem0000000000000",
          },
          { uid: "owner-uid", signInProvider: "google.com" },
          request,
          { signal: new AbortController().signal, onChunk: () => {} },
        ),
      );
    }
    return { results, requests: provider.requests, kept: store.records().length };
  }

  it("answers identically, and only a yes keeps anything", async () => {
    const on = await run(true);
    const off = await run(false);
    const unanswered = await run(null);
    expect(off.results).toEqual(on.results);
    expect(unanswered.results).toEqual(on.results);
    expect(off.requests).toEqual(on.requests);
    expect(on.results[1]?.proposal?.calls).toHaveLength(1);
    expect([on.kept, off.kept, unanswered.kept]).toEqual([3, 0, 0]);
  });
});
