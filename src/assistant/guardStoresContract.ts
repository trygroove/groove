import { describe, expect, it } from "vitest";
import {
  type CallScript,
  createScriptedAssistantProvider,
  MINIMAL_ASSISTANT_CONTEXT,
  replyEvents,
} from "../testing/scriptedAssistantProvider";
import { ASSISTANT_CALL_LIMITS, ASSISTANT_MODELS } from "./config";
import {
  type AssistantCaller,
  type AssistantGuardLimits,
  runAssistantTurn,
} from "./gateway";
import type { AssistantGuardStores } from "./guards";
import { type AssistantErrorCode, AssistantGatewayError } from "./protocol";
import { spendDay } from "./spend";
import { type AssistantTurnLog, TURN_LOG_KEYS } from "./telemetry";

/**
 * What the assistant's limits do (#69, ADR 0006 decisions 4 to 6), through
 * the gateway with a scripted provider, run against the in-memory store here
 * and the Firestore store in the emulator suite. Every way a turn can end is
 * covered, because every provider call counts against the account, however
 * the call ends.
 */
export interface GuardStoresHarness {
  /** A fresh, empty store. */
  stores(): Promise<AssistantGuardStores>;
  /** Flips the kill switch the way the product owner does, in the console. */
  setEnabled(enabled: boolean): Promise<void>;
}

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 5, 12);
const LIMITS: AssistantGuardLimits = {
  requestsPerWindow: 3,
  windowMs: 24 * HOUR,
  dailySpendCeilingUsd: 25,
};
const CALLER: AssistantCaller = { uid: "contract-uid", signInProvider: "google.com" };
const TURN = {
  projectRevision: 0,
  messages: [{ role: "user", text: "Name the private track" }],
  context: { ...MINIMAL_ASSISTANT_CONTEXT, projectName: "Private Project" },
};

export function describeGuardStoresContract(
  name: string,
  harness: GuardStoresHarness,
): void {
  describe(`assistant limits contract (${name})`, () => {
    async function setup(
      scripts: readonly CallScript[],
      limits: AssistantGuardLimits = LIMITS,
    ) {
      const guards = await harness.stores();
      const provider = createScriptedAssistantProvider(scripts);
      const logs: AssistantTurnLog[] = [];
      let now = START;
      const turn = (
        caller: AssistantCaller = CALLER,
        signal: AbortSignal = new AbortController().signal,
      ) =>
        runAssistantTurn(
          {
            provider,
            guards,
            log: (record) => logs.push(record),
            now: () => now,
            sleep: async () => {},
            limits: { ...ASSISTANT_CALL_LIMITS, inactivityTimeoutMs: 50 },
            guardLimits: limits,
          },
          caller,
          TURN,
          { signal, onChunk: () => {} },
        );
      return {
        guards,
        provider,
        logs,
        turn,
        advance: (ms: number) => {
          now += ms;
        },
      };
    }

    async function codeOf(promise: Promise<unknown>): Promise<AssistantErrorCode> {
      const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
      );
      if (!(error instanceof AssistantGatewayError))
        throw new Error("expected a gateway error");
      return error.code;
    }

    /** How many calls the account's record holds, read without adding one. */
    async function used(guards: AssistantGuardStores, uid = CALLER.uid as string) {
      let calls = 0;
      await guards.reserveCall(uid, (record) => {
        calls = record?.calls.length ?? 0;
        return { allowed: false, resetsAt: 0 };
      });
      return calls;
    }

    it("never counts a request from a caller with no account, or a guest", async () => {
      const t = await setup([replyEvents(["hi"])]);
      expect(await codeOf(t.turn({ uid: null, signInProvider: null }))).toBe(
        "unauthenticated",
      );
      expect(await codeOf(t.turn({ uid: "guest", signInProvider: "anonymous" }))).toBe(
        "unauthenticated",
      );
      expect(t.provider.requests).toHaveLength(0);
      expect(await used(t.guards, "guest")).toBe(0);
    });

    it("stops at the cap with a recoverable error naming when the window resets", async () => {
      const t = await setup([replyEvents(["hi"])]);
      const remaining = [];
      for (let i = 0; i < LIMITS.requestsPerWindow; i += 1) {
        remaining.push((await t.turn()).requestsRemaining);
        t.advance(HOUR);
      }
      expect(remaining).toEqual([2, 1, 0]);
      const error = await t.turn().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AssistantGatewayError);
      const refusal = error as AssistantGatewayError;
      expect(refusal.code).toBe("quota_exceeded");
      expect(refusal.details).toEqual({
        code: "quota_exceeded",
        retryable: false,
        resetsAt: START + LIMITS.windowMs,
      });
      expect(refusal.message).toContain("requests");
      expect(refusal.message).toContain("2026-10-06 12:00 UTC");
      expect(t.provider.requests).toHaveLength(LIMITS.requestsPerWindow);

      // A rolling window: the oldest request frees up, not a midnight reset.
      t.advance(START + LIMITS.windowMs - (START + 3 * HOUR));
      expect((await t.turn()).requestsRemaining).toBe(0);
    });

    it("counts every provider call, retries included", async () => {
      const t = await setup([
        [{ fail: "overloaded", status: 529 }],
        [{ fail: "server_error", status: 503 }],
        replyEvents(["third time"]),
      ]);
      expect((await t.turn()).requestsRemaining).toBe(0);
      expect(t.provider.requests).toHaveLength(3);
    });

    it("stops retrying the moment a retry would go over the cap", async () => {
      const t = await setup([[{ fail: "overloaded", status: 529 }]], {
        ...LIMITS,
        requestsPerWindow: 2,
      });
      expect(await codeOf(t.turn())).toBe("quota_exceeded");
      expect(t.provider.requests).toHaveLength(2);
      expect(t.logs[0]).toMatchObject({ outcome: "quota_exceeded", attempts: 2 });
    });

    it.each([
      ["a timeout", [[{ hang: true }]], "timeout"],
      ["a provider error", [[{ fail: "rejected", status: 400 }]], "provider_error"],
      [
        "a malformed stream",
        [[...replyEvents(["half"]).slice(0, 3), { event: 7 }]],
        "malformed_response",
      ],
    ] satisfies [string, CallScript[], AssistantErrorCode][])(
      "counts a call that ended in %s, and logs it redacted",
      async (_, scripts, code) => {
        const t = await setup(scripts);
        expect(await codeOf(t.turn())).toBe(code);
        expect(await used(t.guards)).toBe(1);
        expect(Object.keys(t.logs[0]).sort()).toEqual([...TURN_LOG_KEYS].sort());
        const logged = JSON.stringify(t.logs);
        for (const secret of ["Private Project", "Name the private track", CALLER.uid]) {
          expect(logged).not.toContain(secret);
        }
      },
    );

    it("counts a call the browser cancelled", async () => {
      const t = await setup([[{ hang: true }]]);
      const controller = new AbortController();
      const pending = t.turn(CALLER, controller.signal);
      // Go away once the call is under way, however long the store took.
      while (t.provider.requests.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      controller.abort();
      expect(await codeOf(pending)).toBe("cancelled");
      expect(await used(t.guards)).toBe(1);
    });

    it("never counts a request the browser abandoned before it was sent", async () => {
      const t = await setup([replyEvents(["hi"])]);
      const controller = new AbortController();
      controller.abort();
      expect(await codeOf(t.turn(CALLER, controller.signal))).toBe("cancelled");
      expect(await used(t.guards)).toBe(0);
    });

    it("never lets racing turns take more than the cap", async () => {
      const t = await setup([replyEvents(["hi"])]);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => t.turn()),
      );
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(
        LIMITS.requestsPerWindow,
      );
      expect(t.provider.requests).toHaveLength(LIMITS.requestsPerWindow);
    });

    it("keeps one account's count apart from another's", async () => {
      const t = await setup([replyEvents(["hi"])], { ...LIMITS, requestsPerWindow: 1 });
      await t.turn();
      await t.turn({ uid: "someone-else", signInProvider: "password" });
      expect(await codeOf(t.turn())).toBe("quota_exceeded");
    });

    it("refuses every turn while the kill switch is off, with no deploy", async () => {
      const t = await setup([replyEvents(["hi"])]);
      await harness.setEnabled(false);
      expect(await codeOf(t.turn())).toBe("assistant_disabled");
      expect(t.provider.requests).toHaveLength(0);
      expect(await used(t.guards)).toBe(0);
      await harness.setEnabled(true);
      expect((await t.turn()).text).toBe("hi");
    });

    it("adds every call's cost to the day's spend and cuts off at the ceiling", async () => {
      // 1M input tokens on Sonnet 5 is $2; a $5 ceiling allows three calls.
      const expensive = replyEvents(["pricey"], {
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      const t = await setup([expensive], {
        ...LIMITS,
        requestsPerWindow: 100,
        dailySpendCeilingUsd: 5,
      });
      await t.turn();
      await t.turn();
      expect(await t.guards.spentMicroUsd(spendDay(START))).toBe(
        2 *
          ASSISTANT_MODELS["claude-sonnet-5"].priceUsdPerMillionTokens.input *
          1_000_000,
      );
      await t.turn();
      expect(await codeOf(t.turn())).toBe("spend_ceiling_reached");
      expect(t.provider.requests).toHaveLength(3);

      // The ceiling is per UTC day.
      t.advance(24 * HOUR);
      expect((await t.turn()).text).toBe("pricey");
    });

    it("holds an internal or admin account to neither the cap nor the ceiling (GRV-112)", async () => {
      const expensive = replyEvents(["pricey"], {
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      const t = await setup([expensive], {
        ...LIMITS,
        requestsPerWindow: 1,
        dailySpendCeilingUsd: 3,
      });
      const unlimited: AssistantCaller = { ...CALLER, unlimited: true };
      const remaining = [];
      for (let i = 0; i < 4; i += 1) {
        remaining.push((await t.turn(unlimited)).requestsRemaining);
      }
      expect(remaining).toEqual([1, 1, 1, 1]);
      expect(t.provider.requests).toHaveLength(4);
      // Nothing is taken from its window, but every call is still spent.
      expect(await used(t.guards)).toBe(0);
      expect(await t.guards.spentMicroUsd(spendDay(START))).toBe(
        4 *
          ASSISTANT_MODELS["claude-sonnet-5"].priceUsdPerMillionTokens.input *
          1_000_000,
      );
      // The same account without the claim is past the ceiling it ran up.
      expect(await codeOf(t.turn())).toBe("spend_ceiling_reached");
    });

    it("stops an internal or admin account at the kill switch all the same", async () => {
      const t = await setup([replyEvents(["hi"])]);
      await harness.setEnabled(false);
      expect(await codeOf(t.turn({ ...CALLER, unlimited: true }))).toBe(
        "assistant_disabled",
      );
      expect(t.provider.requests).toHaveLength(0);
      await harness.setEnabled(true);
    });

    it("charges a call that stopped mid-reply for the text it streamed", async () => {
      // 3,000 characters is an estimated 1,000 output tokens; the stream
      // stalls before the provider reports its own count, and times out.
      const [start, block, delta] = replyEvents(["x".repeat(3_000)], { inputTokens: 0 });
      const t = await setup([[start, block, delta, { hang: true }]]);
      expect(await codeOf(t.turn())).toBe("timeout");
      expect(await t.guards.spentMicroUsd(spendDay(START))).toBe(
        1_000 * ASSISTANT_MODELS["claude-sonnet-5"].priceUsdPerMillionTokens.output,
      );
    });
  });
}
