/**
 * GRV-150: the reply agrees with the project context it was sent. Two code
 * checks on the reply's text alone, so they judge a turn whether or not it
 * proposed anything:
 *
 * - {@link checkNoDeniedTrack}: the reply never says a track the project has
 *   is missing ("There's no snare track in the project yet — I never actually
 *   added it", with SD in the description).
 * - {@link checkNoAbsentTrack}: the reply never mentions a track the project
 *   does not have (the "Closed Hat" track whose proposal was cancelled).
 *
 * A case names the words for each in {@link ProjectFacts}: the names a
 * producer would call a track it has, and the names of one it lacks.
 */
import type { CheckResult } from "./checks";

const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const fail = (detail: string): CheckResult => ({ status: "fail", detail });

/** What a case knows of its project that the reply has to agree with. */
export interface ProjectFacts {
  /** Words naming a track the project has: "snare", "SD". */
  readonly present?: readonly string[];
  /** Words naming a track it does not have: "closed hat", "hi-hat". */
  readonly absent?: readonly string[];
}

/** The checks here, which read the reply's text and nothing else. */
export const REPLY_CHECK_IDS = ["noDeniedTrack", "noAbsentTrack"] as const;
export type ReplyCheckId = (typeof REPLY_CHECK_IDS)[number];

function wordSource(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]?");
}

/** `words` as one whole-word alternation, plurals included ("hat" finds "hats"). */
function namesSource(words: readonly string[]): string {
  return `\\b(?:${words.map(wordSource).join("|")})s?\\b`;
}

function wordsPattern(words: readonly string[]): RegExp {
  return new RegExp(namesSource(words), "i");
}

/** The reply in sentences: a full stop, a question or a line ends one; a dash does not. */
function sentences(text: string): string[] {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** "Is not there" or "was never made", after the name: "SD doesn't exist", "the snare was never added". */
const NOT_THERE =
  "(?:(?:does|is|was|has|have|did)(?:n't| not)(?: yet| actually)? (?:exist|there|in the (?:project|song)|(?:been )?(?:added|applied|created|made))|(?:not|never)(?: yet)? in the (?:project|song)|never (?:actually |really )?(?:been |got )?(?:added|applied|created|made|landed))";

/**
 * The ways a sentence says the named track is not there, each bound to the
 * name so "there's no EQ on the SD" is not one: "there's no snare", "no SD
 * track", "don't have a snare", "the SD track doesn't exist", and, in a
 * sentence that names it, "it isn't in the project" or "never actually added it".
 */
function denials(names: string): RegExp[] {
  return [
    new RegExp(
      `\\b(?:there(?:'s| is| are) no|no|without (?:a|an|any)|(?:don't|do not|doesn't|does not) (?:see|have)(?: a| an| any)?) (?:\\w+ )?${names}`,
      "i",
    ),
    new RegExp(`${names}(?: track)?(?: \\w+){0,3} ${NOT_THERE}`, "i"),
    new RegExp(`\\b(?:it|that)(?: track)? ${NOT_THERE}`, "i"),
    /\bnever (?:actually |really )?(?:added|applied|created|made) it\b/i,
  ];
}

/**
 * The reply never says a track the project has is missing: no sentence that
 * names one of `facts.present` also says it is not there or was never made.
 * With no `present` words, it has nothing to judge and passes.
 */
export function checkNoDeniedTrack(text: string, facts: ProjectFacts = {}): CheckResult {
  const present = facts.present ?? [];
  if (present.length === 0) return pass("The case names no track the project has");
  const names = wordsPattern(present);
  const patterns = denials(namesSource(present));
  const denied = sentences(text).find(
    (sentence) =>
      names.test(sentence) && patterns.some((pattern) => pattern.test(sentence)),
  );
  return denied
    ? fail(`Says a track the project has is missing: "${denied}"`)
    : pass(`Never says ${present.join(" / ")} is missing`);
}

/**
 * The reply never mentions a track the project does not have: none of
 * `facts.absent`'s words appears in it at all. A correct answer has no reason
 * to bring up a part that was never added.
 */
export function checkNoAbsentTrack(text: string, facts: ProjectFacts = {}): CheckResult {
  const absent = facts.absent ?? [];
  if (absent.length === 0) return pass("The case names no track the project lacks");
  const found = sentences(text).find((sentence) => wordsPattern(absent).test(sentence));
  return found
    ? fail(`Mentions a track the project does not have: "${found}"`)
    : pass(`Never mentions ${absent.join(" / ")}`);
}

/** Whether `id` is one of {@link REPLY_CHECK_IDS}. */
export function isReplyCheck(id: string): id is ReplyCheckId {
  return (REPLY_CHECK_IDS as readonly string[]).includes(id);
}

/** Runs the reply check `id` on the reply's text. */
export function runReplyCheck(
  id: ReplyCheckId,
  text: string,
  facts: ProjectFacts = {},
): CheckResult {
  switch (id) {
    case "noDeniedTrack":
      return checkNoDeniedTrack(text, facts);
    case "noAbsentTrack":
      return checkNoAbsentTrack(text, facts);
  }
}
