/**
 * The checks of GRV-207's takes cases: whether a request for a part got four
 * takes to pick from, and whether they are really four different takes.
 * Code checks, pure functions of the turn's `offer_takes` calls, with no LLM
 * judge:
 *
 * - {@link checkOffersTakes} (29): a melody, bassline, lead or chords request
 *   ends in exactly one offer of four takes, and every take writes notes no
 *   other take writes, compared as they sound (pitch, start and length,
 *   never IDs or velocities: `takeNoteContent` in `takes.ts`).
 * - {@link checkNoTakes} (30): a drums request gets no offer of takes; drums
 *   take the usual one proposal (their own card is GRV-213).
 *
 * The proposal checks judge such a turn by its first take (`withFirstTake`),
 * so these two are the only ones that read the offer itself.
 */
import type { AssistantToolCall } from "../protocol";
import {
  parseTakesCall,
  TAKE_COUNT,
  takeNoteContent,
  takesWithSameNotes,
} from "../takes";
import type { CheckResult } from "./checks";

export const TAKES_CHECK_IDS = ["offersTakes", "noTakes"] as const;
export type TakesCheckId = (typeof TAKES_CHECK_IDS)[number];

/** Whether `id` is one of {@link TAKES_CHECK_IDS}. */
export function isTakesCheck(id: string): id is TakesCheckId {
  return (TAKES_CHECK_IDS as readonly string[]).includes(id);
}

const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const fail = (detail: string): CheckResult => ({ status: "fail", detail });

/** 29: one offer of four takes, each playing notes of its own. */
export function checkOffersTakes(offers: readonly AssistantToolCall[]): CheckResult {
  if (offers.length === 0) return fail("Offered no takes");
  if (offers.length > 1) return fail(`Offered ${offers.length} sets of takes, not one`);
  const takes = parseTakesCall(offers[0]);
  if (!takes) return fail("The offer of takes was refused or did not parse");
  if (takes.takes.length !== TAKE_COUNT) {
    return fail(`Offered ${takes.takes.length} takes, not ${TAKE_COUNT}`);
  }
  const silent = takes.takes.findIndex((take) => takeNoteContent(take.calls) === null);
  if (silent !== -1) return fail(`Take ${silent + 1} writes no notes`);
  const same = takesWithSameNotes(takes.takes);
  if (same) return fail(`Takes ${same[0]} and ${same[1]} play the same notes`);
  return pass(
    `${TAKE_COUNT} takes of the ${takes.part}, each with notes of its own: ${takes.takes
      .map((take) => take.label)
      .join("; ")}`,
  );
}

/** 30: no offer of takes. */
export function checkNoTakes(offers: readonly AssistantToolCall[]): CheckResult {
  return offers.length === 0
    ? pass("Offered no takes")
    : fail(`Offered takes (${offers.length} ${offers.length === 1 ? "set" : "sets"})`);
}

/** Runs the takes check `id` on a turn's offers. */
export function runTakesCheck(
  id: TakesCheckId,
  offers: readonly AssistantToolCall[],
): CheckResult {
  return id === "offersTakes" ? checkOffersTakes(offers) : checkNoTakes(offers);
}
