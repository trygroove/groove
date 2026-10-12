import type { CallableRequest } from "firebase-functions/v2/https";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryTranscriptStore } from "../../src/assistant/inMemoryTranscriptStore";
import { transcriptRecordFor } from "../../src/assistant/transcripts";
import { createTranscriptAdminHandler } from "./transcriptAdminHandler";

vi.mock("firebase-functions", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function request(
  token: Record<string, unknown> | null,
  data: unknown,
): CallableRequest<unknown> {
  return {
    auth: token ? { uid: "caller-uid", token } : undefined,
    data,
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const RECORD = transcriptRecordFor({
  uid: "producer-uid",
  session: {
    conversationId: "conversation-1",
    turnId: "turn-0001",
    projectId: "prj_one",
    internal: false,
  },
  internalAccount: false,
  projectRevision: 1,
  userMessage: "Add an atmospheric layer",
  reply: "Here is a pad.",
  stopReason: "tool_use",
  proposal: null,
  model: "claude-sonnet-5",
  promptVersion: "1",
  receivedAt: Date.UTC(2026, 9, 9),
});

describe("assistantTranscriptsAdmin handler (GRV-98)", () => {
  it("lists and opens turns for an admin", async () => {
    const store = createInMemoryTranscriptStore();
    await store.writeIfPermitted(RECORD, () => true);
    const handler = createTranscriptAdminHandler(() => store);
    await expect(
      handler(request({ admin: true }, { op: "list" })),
    ).resolves.toMatchObject({ turns: [{ uid: "producer-uid", turnId: "turn-0001" }] });
    await expect(
      handler(
        request({ admin: true }, { op: "get", uid: "producer-uid", turnId: "turn-0001" }),
      ),
    ).resolves.toEqual({ turn: RECORD });
  });

  it("maps each refusal to its HTTPS code, reading nothing", async () => {
    const store = createInMemoryTranscriptStore();
    const recent = vi.spyOn(store, "recent");
    const read = vi.spyOn(store, "read");
    const handler = createTranscriptAdminHandler(() => store);
    const cases: [Record<string, unknown> | null, unknown, string][] = [
      [null, { op: "list" }, "unauthenticated"],
      [{}, { op: "list" }, "permission-denied"],
      [{ admin: "true" }, { op: "list" }, "permission-denied"],
      [{ admin: true }, { op: "delete" }, "invalid-argument"],
    ];
    for (const [token, data, code] of cases) {
      await expect(handler(request(token, data))).rejects.toMatchObject({ code });
    }
    expect(recent).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("hides an unexpected failure behind a generic internal error", async () => {
    const store = createInMemoryTranscriptStore();
    store.recent = () => Promise.reject(new Error("Add an atmospheric layer"));
    const handler = createTranscriptAdminHandler(() => store);
    const failure = handler(request({ admin: true }, { op: "list" }));
    await expect(failure).rejects.toMatchObject({ code: "internal" });
    await expect(failure).rejects.not.toThrow(/atmospheric/);
  });
});
