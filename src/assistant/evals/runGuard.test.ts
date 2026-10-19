import { describe, expect, it } from "vitest";
import type { EvalTurnError } from "./run";
import {
  AUTH_ABORT_REASON,
  CREDIT_ABORT_REASON,
  REFUSAL_STREAK,
  RunGuard,
  refusalAbortReason,
} from "./runGuard";

const REPLY = { error: null, turnError: null };

function failed(status: number | null, extra: Partial<EvalTurnError> = {}) {
  return {
    error: "provider_error",
    turnError: {
      code: "provider_error",
      message: "The assistant could not take that request.",
      providerStatus: status,
      providerFailures: ["rejected"],
      ...extra,
    },
  };
}

function observeMany(guard: RunGuard, turn: ReturnType<typeof failed>, times: number) {
  for (let index = 0; index < times; index += 1) guard.observe(turn);
}

describe("RunGuard", () => {
  it("stops after a streak of refused turns, whatever the provider said", () => {
    const guard = new RunGuard();
    guard.observe(REPLY);
    observeMany(guard, failed(400), REFUSAL_STREAK - 1);
    expect(guard.reason).toBeNull();
    expect(guard.observe(failed(400))).toBe(refusalAbortReason(400));
    expect(guard.reason).toContain("spend limit");
  });

  it("starts the streak over when a turn replies between refusals", () => {
    const guard = new RunGuard();
    observeMany(guard, failed(400), REFUSAL_STREAK - 1);
    guard.observe(REPLY);
    observeMany(guard, failed(400), REFUSAL_STREAK - 1);
    expect(guard.reason).toBeNull();
  });

  it("does not count rate limits, timeouts, overloads or turns with no status", () => {
    const guard = new RunGuard();
    for (const status of [429, 408, 529, 500, null]) {
      observeMany(guard, failed(status), REFUSAL_STREAK);
    }
    expect(guard.reason).toBeNull();
  });

  it("stops at once on a rejected key before any reply, and not after one", () => {
    const first = new RunGuard();
    expect(first.observe(failed(401))).toBe(AUTH_ABORT_REASON);
    const later = new RunGuard();
    later.observe(REPLY);
    expect(later.observe(failed(401))).toBeNull();
  });

  it("stops at once when the provider says the account is out of credit", () => {
    const guard = new RunGuard();
    guard.observe(REPLY);
    expect(guard.observe(failed(400, { outOfCredit: true }))).toBe(CREDIT_ABORT_REASON);
  });

  it("keeps the first reason", () => {
    const guard = new RunGuard();
    guard.observe(failed(400, { outOfCredit: true }));
    observeMany(guard, failed(400), REFUSAL_STREAK);
    expect(guard.reason).toBe(CREDIT_ABORT_REASON);
  });
});
