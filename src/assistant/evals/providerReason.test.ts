// @vitest-environment node
/**
 * GRV-147: a refused model call says why in the errored turn. The experiment
 * run on main had every turn refused with a bare "HTTP 400", and the API's own
 * reason, which would have said what was wrong, was thrown away.
 *
 * The real Anthropic provider over a scripted `fetch`, wrapped the way the
 * eval scripts wrap it, through the evals' own turn runner.
 */
import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../../../functions/src/anthropicProvider";
import { TYPESCRIPT_CASES } from "./cases";
import { withProviderReasons } from "./providerReason";
import { runCaseTurn } from "./run";

const evalCase = TYPESCRIPT_CASES[0];

/** A `fetch` that answers every call with the API's error body. */
function refusingFetch(status: number, type: string, message: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        type: "error",
        error: { type, message },
        request_id: "req_011CUexample",
      }),
      { status, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

function evalProvider(fetchImpl: typeof fetch) {
  return withProviderReasons(
    (wrapped) => createAnthropicProvider({ apiKey: "k", fetch: wrapped }),
    fetchImpl,
  );
}

describe("a refused provider call in the evals", () => {
  it("carries the API's error type and message into the errored turn", async () => {
    const turn = await runCaseTurn(evalCase, {
      provider: evalProvider(
        refusingFetch(
          400,
          "invalid_request_error",
          "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
        ),
      ),
    });
    expect(turn.turnError?.providerStatus).toBe(400);
    expect(turn.error).toContain(
      "The provider said: invalid_request_error: You have reached your specified API usage limits.",
    );
  });

  it("scrubs keys, quoted text and URLs out of the reason", async () => {
    const turn = await runCaseTurn(evalCase, {
      provider: evalProvider(
        refusingFetch(
          400,
          "invalid_request_error",
          'messages.0.content: "make the bass funkier" is invalid for key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789, see https://docs.anthropic.com/errors',
        ),
      ),
    });
    expect(turn.error).toContain(
      "The provider said: invalid_request_error: messages.0.content",
    );
    expect(turn.error).not.toContain("funkier");
    expect(turn.error).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(turn.error).not.toContain("docs.anthropic.com");
  });

  it("says nothing more when the body is not the API's error shape", async () => {
    const turn = await runCaseTurn(evalCase, {
      provider: evalProvider(
        (async () =>
          new Response("<html>bad gateway</html>", {
            status: 400,
          })) as unknown as typeof fetch,
      ),
    });
    expect(turn.turnError?.providerStatus).toBe(400);
    expect(turn.error).not.toContain("The provider said");
    expect(turn.error).not.toContain("html");
  });
});
