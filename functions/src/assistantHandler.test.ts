import { logger } from "firebase-functions";
import type { CallableRequest, CallableResponse } from "firebase-functions/v2/https";
import { HttpsError } from "firebase-functions/v2/https";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryGuardStores } from "../../src/assistant/inMemoryGuardStores";
import { createInMemoryTranscriptStore } from "../../src/assistant/inMemoryTranscriptStore";
import type {
  AssistantStreamChunk,
  AssistantTurnRequest,
} from "../../src/assistant/protocol";
import type { AssistantTurnLog } from "../../src/assistant/telemetry";
import {
  type CallScript,
  createScriptedAssistantProvider,
  MINIMAL_ASSISTANT_CONTEXT,
  replyEvents,
} from "../../src/testing/scriptedAssistantProvider";
import { createAssistantHandler } from "./assistantHandler";

const turn: AssistantTurnRequest = {
  projectRevision: 0,
  messages: [{ role: "user", text: "hello" }],
  context: MINIMAL_ASSISTANT_CONTEXT,
};

function callable(
  auth: { uid: string; provider: string } | null,
  data: unknown = turn,
): CallableRequest<unknown> {
  return {
    data,
    auth: auth
      ? {
          uid: auth.uid,
          token: { firebase: { sign_in_provider: auth.provider } },
        }
      : undefined,
    acceptsStreaming: true,
    rawRequest: {},
  } as unknown as CallableRequest<unknown>;
}

function streamingResponse(signal = new AbortController().signal) {
  const chunks: AssistantStreamChunk[] = [];
  const response: CallableResponse<AssistantStreamChunk> = {
    signal,
    sendChunk: async (chunk) => {
      chunks.push(chunk);
      return true;
    },
  };
  return { chunks, response };
}

function handler(scripts: readonly CallScript[]) {
  const logs: AssistantTurnLog[] = [];
  const provider = createScriptedAssistantProvider(scripts);
  const guards = createInMemoryGuardStores();
  return {
    logs,
    guards,
    provider,
    handle: createAssistantHandler(() => ({
      provider,
      guards,
      log: (record) => logs.push(record),
      sleep: async () => {},
    })),
  };
}

async function httpsErrorOf(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) return error;
    throw error;
  }
  throw new Error("expected an HttpsError");
}

describe("createAssistantHandler", () => {
  it("streams chunks to the callable response and returns the reply", async () => {
    const { handle } = handler([replyEvents(["Hello ", "there"])]);
    const { chunks, response } = streamingResponse();
    const result = await handle(
      callable({ uid: "u1", provider: "google.com" }),
      response,
    );
    expect(chunks.map((chunk) => chunk.text)).toEqual(["Hello ", "there"]);
    expect(result.text).toBe("Hello there");
  });

  it("refuses a call with no auth as unauthenticated", async () => {
    const { handle, provider } = handler([replyEvents(["x"])]);
    const error = await httpsErrorOf(
      handle(callable(null), streamingResponse().response),
    );
    expect(error.code).toBe("unauthenticated");
    expect(error.details).toEqual({ code: "unauthenticated", retryable: false });
    expect(provider.requests).toHaveLength(0);
  });

  it("reads a guest from the ID token's sign-in provider", async () => {
    const { handle } = handler([replyEvents(["x"])]);
    const error = await httpsErrorOf(
      handle(callable({ uid: "g", provider: "anonymous" }), streamingResponse().response),
    );
    expect(error.code).toBe("unauthenticated");
  });

  it.each([
    [[[{ fail: "rejected", status: 400 }]], "failed-precondition", "provider_error"],
    [[[{ fail: "overloaded", status: 529 }]], "unavailable", "provider_unavailable"],
    [[[{ event: "garbage" }]], "internal", "malformed_response"],
  ] satisfies [CallScript[], string, string][])(
    "maps a provider failure onto an HttpsError (%#)",
    async (scripts, httpsCode, code) => {
      const { handle } = handler(scripts);
      const error = await httpsErrorOf(
        handle(
          callable({ uid: "u", provider: "google.com" }),
          streamingResponse().response,
        ),
      );
      expect(error.code).toBe(httpsCode);
      expect((error.details as { code: string }).code).toBe(code);
    },
  );

  it("reports a provider down for everyone to error monitoring once, until a turn gets through (GRV-206)", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const outOfCredit: CallScript = [
        { fail: "rejected", status: 400, outOfCredit: true },
      ];
      const { handle } = handler([
        outOfCredit,
        outOfCredit,
        replyEvents(["Back."]),
        outOfCredit,
      ]);
      const ask = () =>
        handle(
          callable({ uid: "u", provider: "google.com" }),
          streamingResponse().response,
        );
      const first = await httpsErrorOf(ask());
      expect(first.code).toBe("unavailable");
      expect(first.details).toEqual({ code: "provider_unavailable", retryable: true });
      await httpsErrorOf(ask());
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0]?.[1]).toEqual({ failure_kind: "out_of_credit" });

      await ask();
      await httpsErrorOf(ask());
      expect(errorLog).toHaveBeenCalledTimes(2);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("logs an unexpected error's name and code, never its message, as internal", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const handle = createAssistantHandler(() => {
        throw Object.assign(new TypeError("leaked prompt: make the bass hit harder"), {
          code: "ERR_SOMETHING",
        });
      });
      const error = await httpsErrorOf(
        handle(callable({ uid: "u", provider: "google.com" }), undefined),
      );
      expect(error.code).toBe("internal");
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0]?.[1]).toEqual({
        name: "TypeError",
        code: "ERR_SOMETHING",
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("bass");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("maps a spent quota onto resource-exhausted, naming when it resets", async () => {
    const { handle, guards } = handler([replyEvents(["x"])]);
    const now = Date.now();
    await guards.reserveCall("u", () => ({
      allowed: true,
      remaining: 0,
      next: { schemaVersion: 1, calls: Array(100).fill(now) },
    }));
    const error = await httpsErrorOf(
      handle(
        callable({ uid: "u", provider: "google.com" }),
        streamingResponse().response,
      ),
    );
    expect(error.code).toBe("resource-exhausted");
    expect(error.details).toEqual({
      code: "quota_exceeded",
      retryable: false,
      resetsAt: now + 24 * 60 * 60 * 1000,
    });
  });

  it("maps the kill switch onto unavailable", async () => {
    const { handle, guards } = handler([replyEvents(["x"])]);
    guards.setEnabled(false);
    const error = await httpsErrorOf(
      handle(
        callable({ uid: "u", provider: "google.com" }),
        streamingResponse().response,
      ),
    );
    expect(error.code).toBe("unavailable");
    expect((error.details as { code: string }).code).toBe("assistant_disabled");
  });

  it("maps a refused request onto invalid-argument", async () => {
    const { handle } = handler([replyEvents(["x"])]);
    const error = await httpsErrorOf(
      handle(callable({ uid: "u", provider: "google.com" }, { messages: [] }), undefined),
    );
    expect(error.code).toBe("invalid-argument");
  });

  async function keptTurnInternal(claims: Record<string, unknown>): Promise<boolean[]> {
    const transcripts = createInMemoryTranscriptStore();
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const handle = createAssistantHandler(() => ({
        provider: createScriptedAssistantProvider([replyEvents(["Swing it."])]),
        guards: createInMemoryGuardStores(),
        transcripts,
      }));
      await transcripts.setPreference("u", {
        schemaVersion: 1,
        retain: true,
        disclosureVersion: 1,
        answeredAt: 0,
      });
      const request = callable(
        { uid: "u", provider: "google.com" },
        {
          ...turn,
          session: {
            conversationId: "conversation-1",
            turnId: "turn-0001",
            projectId: "prj_one",
            internal: false,
          },
        },
      );
      Object.assign(request.auth?.token ?? {}, claims);
      await handle(request, streamingResponse().response);
      // How it went is logged as a code; what was said never is.
      expect(info).toHaveBeenCalledWith("assistant transcript", { write: "kept" });
      expect(JSON.stringify(info.mock.calls)).not.toContain("Swing it.");
      return transcripts.records().map((record) => record.internal);
    } finally {
      info.mockRestore();
    }
  }

  it("marks a flagged account's kept turn internal, from the ID token's claim", async () => {
    expect(await keptTurnInternal({ internal: true })).toEqual([true]);
  });

  // GRV-113: the address is not what makes an account internal.
  it.each([
    ["no claim", { email: "someone@example.com" }],
    ["a claim that is not true", { internal: "true" }],
  ])("leaves the kept turn of an account with %s as it was", async (_, claims) => {
    expect(await keptTurnInternal(claims)).toEqual([false]);
  });

  // GRV-112: the claims, never the address, lift the quota.
  async function quotaCodes(claims: Record<string, unknown>): Promise<string[]> {
    const provider = createScriptedAssistantProvider([replyEvents(["ok"])]);
    const guards = createInMemoryGuardStores();
    const handle = createAssistantHandler(() => ({
      provider,
      guards,
      log: () => {},
      guardLimits: { requestsPerWindow: 1, windowMs: 60_000, dailySpendCeilingUsd: 25 },
    }));
    const codes: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const request = callable({ uid: "u", provider: "google.com" });
      Object.assign(request.auth?.token ?? {}, claims);
      codes.push(
        await handle(request, streamingResponse().response).then(
          () => "ok",
          (error: unknown) => (error instanceof HttpsError ? error.code : "thrown"),
        ),
      );
    }
    return codes;
  }

  it.each([
    ["internal", { internal: true }],
    ["admin", { admin: true }],
  ])("does not hold an %s account to the request quota", async (_, claims) => {
    expect(await quotaCodes(claims)).toEqual(["ok", "ok"]);
  });

  it.each([
    ["no claim", { email: "someone@example.com" }],
    ["claims that are not true", { internal: "true", admin: 1 }],
  ])("holds an account with %s to the request quota", async (_, claims) => {
    expect(await quotaCodes(claims)).toEqual(["ok", "resource-exhausted"]);
  });

  it("cancels when the client disconnects", async () => {
    const controller = new AbortController();
    const { handle, logs } = handler([
      [...replyEvents(["a"]).slice(0, 3), { hang: true }],
    ]);
    const { response } = streamingResponse(controller.signal);
    const pending = handle(callable({ uid: "u", provider: "google.com" }), response);
    setTimeout(() => controller.abort(), 10);
    const error = await httpsErrorOf(pending);
    expect(error.code).toBe("cancelled");
    expect(logs[0].outcome).toBe("cancelled");
  });
});
