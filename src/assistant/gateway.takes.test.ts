import { describe, expect, it } from "vitest";
import { createReferenceProject } from "../domain/fixtures";
import {
  createScriptedAssistantProvider,
  toolUseEvents,
} from "../testing/scriptedAssistantProvider";
import { offerTakesCall, offerTakesInput } from "../testing/takes";
import { createNoteExpander } from "./compactNotes";
import { ASSISTANT_CALL_LIMITS } from "./config";
import { runAssistantTurn } from "./gateway";
import { createInMemoryGuardStores } from "./inMemoryGuardStores";
import { buildAssistantPayload } from "./payload";
import type { AssistantStreamChunk, AssistantTurnRequest } from "./protocol";
import { contextTargets } from "./recommendationTargets";
import { answerStep, TAKES_RESULT } from "./steps";
import {
  expandTakesCall,
  OFFER_TAKES_TOOL_NAME,
  parseTakesCall,
  TAKE_NOTE_MARK,
} from "./takes";

const STEM = "Stem0000000000000";
const project = createReferenceProject();

function request(): AssistantTurnRequest {
  return {
    projectRevision: project.metadata.revision,
    messages: [{ role: "user", text: "Write me a lead melody" }],
    context: buildAssistantPayload(project),
  };
}

async function turn(
  scripts: Parameters<typeof createScriptedAssistantProvider>[0],
  continuations: Parameters<typeof createScriptedAssistantProvider>[1] = [],
) {
  const provider = createScriptedAssistantProvider(scripts, continuations);
  const chunks: AssistantStreamChunk[] = [];
  let clock = 1_000;
  const result = await runAssistantTurn(
    {
      provider,
      guards: createInMemoryGuardStores(),
      log: () => {},
      now: () => {
        clock += 5;
        return clock;
      },
      sleep: async () => {},
      limits: { ...ASSISTANT_CALL_LIMITS, inactivityTimeoutMs: 200 },
      idStem: () => STEM,
    },
    { uid: "uid-1", signInProvider: "google.com" },
    request(),
    { signal: new AbortController().signal, onChunk: (chunk) => chunks.push(chunk) },
  );
  return { result, provider, chunks };
}

describe("runAssistantTurn: four takes to pick from (GRV-207)", () => {
  it("offers offer_takes on every turn", async () => {
    const { provider } = await turn([
      toolUseEvents("Four takes of a lead.", [offerTakesCall(project)]),
    ]);
    expect(provider.requests[0].tools.map((tool) => tool.name)).toContain(
      OFFER_TAKES_TOOL_NAME,
    );
  });

  it("ends the turn on an offer, its takes' notes written out, as one model call", async () => {
    const { result, provider, chunks } = await turn([
      toolUseEvents("Four takes of a lead.", [offerTakesCall(project)]),
    ]);
    // One provider call: the offer is the turn's last word, so one quota unit.
    expect(provider.requests).toHaveLength(1);
    expect(result.stopReason).toBe("tool_use");
    const [offer] = result.proposal?.calls ?? [];
    expect(offer?.name).toBe(OFFER_TAKES_TOOL_NAME);
    expect(offer?.refusal).toBeUndefined();
    const takes = offer && parseTakesCall(offer);
    expect(takes?.takes).toHaveLength(4);
    const first = takes?.takes[0]?.calls[1]?.input as {
      content: { events: { id: string }[] };
    };
    expect(first.content.events[0]?.id).toBe(`evt_${STEM}${TAKE_NOTE_MARK}001`);
    // An offer is not a part of a proposal: nothing streams to a part's card.
    expect(chunks.some((chunk) => chunk.part)).toBe(false);
  });

  it("refuses an offer a take of which does not fit back to the model, which sends it again", async () => {
    const broken = offerTakesInput(project);
    broken.takes[1].calls[1] = {
      ...broken.takes[1].calls[1],
      input: {
        ...broken.takes[1].calls[1].input,
        content: { kind: "notes", events: [[1]] },
      },
    };
    const { result, provider } = await turn(
      [toolUseEvents("Four takes.", [{ name: OFFER_TAKES_TOOL_NAME, input: broken }])],
      [toolUseEvents("Fixed.", [offerTakesCall(project)])],
    );
    expect(provider.requests).toHaveLength(2);
    const told = JSON.stringify(provider.requests[1].messages.at(-1));
    expect(told).toContain("take 2, call 2 (clip_create)");
    const offers = result.proposal?.calls.filter(
      (call) => call.name === OFFER_TAKES_TOOL_NAME,
    );
    expect(offers).toHaveLength(1);
    expect(offers?.[0]?.refusal).toBeUndefined();
  });

  it("tells the model an offer joined the turn when the step is answered", () => {
    const offer = { id: "toolu_1", ...offerTakesCall(project) };
    const answered = answerStep(
      [offer],
      contextTargets(buildAssistantPayload(project)),
      createNoteExpander(STEM),
      { takes: (call) => expandTakesCall(call, STEM) },
    );
    expect(answered.results).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: TAKES_RESULT },
    ]);
    expect(answered.kept).toHaveLength(1);
    expect(parseTakesCall(answered.kept[0] as never)?.takes).toHaveLength(4);
  });
});
