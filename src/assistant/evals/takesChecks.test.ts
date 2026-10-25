import { describe, expect, it } from "vitest";
import { createReferenceProject } from "../../domain/fixtures";
import { offerTakesCall } from "../../testing/takes";
import type { AssistantToolCall } from "../protocol";
import { expandTakesCall, type OfferTakesInput } from "../takes";
import { checkNoTakes, checkOffersTakes } from "./takesChecks";

const STEM = "Stem0000000000000";
const project = createReferenceProject();

/** An offer of four takes as the gateway writes it out. */
function offer(id = "toolu_1"): AssistantToolCall {
  const written = expandTakesCall({ id, ...offerTakesCall(project) }, STEM);
  if (!written.ok) throw new Error(written.message);
  return written.call;
}

/** The offer with take `index`'s calls changed, as a model past the gateway might send it. */
function withTake(
  call: AssistantToolCall,
  index: number,
  change: (take: OfferTakesInput["takes"][number]) => OfferTakesInput["takes"][number],
): AssistantToolCall {
  const input = structuredClone(call.input) as OfferTakesInput;
  input.takes[index] = change(input.takes[index]);
  return { ...call, input };
}

describe("29. Four takes, each with notes of its own (GRV-207)", () => {
  it("passes one offer of four takes that each play different notes", () => {
    const result = checkOffersTakes([offer()]);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Sparse and low");
  });

  it("fails a turn that offered none, or more than one", () => {
    expect(checkOffersTakes([]).detail).toBe("Offered no takes");
    expect(checkOffersTakes([offer("a"), offer("b")]).status).toBe("fail");
  });

  it("fails an offer the gateway refused", () => {
    const refused = { ...offer(), refusal: "take 1, call 2: not a note" };
    expect(checkOffersTakes([refused]).status).toBe("fail");
  });

  it("fails two takes that play the same notes under different labels", () => {
    const call = offer();
    const input = call.input as OfferTakesInput;
    const same = withTake(call, 3, (take) => ({
      ...take,
      calls: structuredClone(input.takes[1].calls),
    }));
    expect(checkOffersTakes([same])).toEqual({
      status: "fail",
      detail: "Takes 2 and 4 play the same notes",
    });
  });

  it("fails a take that writes no notes", () => {
    const silent = withTake(offer(), 0, (take) => ({ ...take, calls: [take.calls[0]] }));
    expect(checkOffersTakes([silent]).detail).toBe("Take 1 writes no notes");
  });
});

describe("30. No takes offered (GRV-207)", () => {
  it("passes a turn with no offer and fails one with any", () => {
    expect(checkNoTakes([]).status).toBe("pass");
    expect(checkNoTakes([offer()]).status).toBe("fail");
  });
});
