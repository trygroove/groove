/**
 * Recommending a pack and its sounds from the library (GRV-23).
 *
 * A recommendation is not a change to the song, so it is not one of the
 * command tools in `tools.ts`: the model calls {@link RECOMMEND_SOUNDS_TOOL}
 * with a pack ID, up to three of that pack's sound IDs, a line on why they fit
 * and the track (on a drum machine, the pad) to try them on. The tool is offered only on a turn that
 * carries the published library (`AssistantTurnRequest.library`), so the model
 * has the IDs to choose from.
 *
 * The gateway returns its calls among the turn's other tool calls; the browser
 * takes them out of the proposal ({@link splitRecommendations}) and checks
 * each against the library it sent ({@link validateRecommendation}). An ID the
 * library does not hold is refused, never shown: the assistant may only
 * recommend what the app can actually play and insert.
 *
 * Trying a recommended sound is audio only, and keeping one goes through the
 * library's own insertion (`src/editor/assistant`), so nothing here touches a
 * project. Like the rest of `src/assistant`, it imports no Firebase and no SDK.
 */
import { z } from "zod";
import { ASSISTANT_LIBRARY_LIMITS } from "./config";
import type {
  AssistantLibraryContext,
  AssistantLibraryPack,
  AssistantLibrarySound,
  AssistantProposal,
  AssistantToolCall,
} from "./protocol";
import type { ProviderTool, ProviderToolInputSchema } from "./providerRequest";

/** The tool's name, as the model calls it. */
export const RECOMMEND_SOUNDS_TOOL = "recommend_sounds";

/** What a recommendation call carries, before it is checked against the library. */
export const recommendationInputSchema = z.object({
  packId: z.string().min(1).max(64).describe("The ID of one pack in the library."),
  soundIds: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(ASSISTANT_LIBRARY_LIMITS.maxRecommendedSounds)
    .describe(
      "The IDs of up to three of that pack's sounds, best first. The first is the one the producer tries.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(ASSISTANT_LIBRARY_LIMITS.maxReasonChars)
    .describe("One short line on why these sounds fit what the producer asked for."),
  trackId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "The ID of the track to try the sounds on; its sample slot plays the first one. Omit it to use the selected track.",
    ),
  padId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "On a drum machine, the ID of the pad to try the sounds on, from that track's pads: the pad whose part the sounds are for (a kick goes on the kick's pad). Omit it on any other track.",
    ),
});
export type RecommendationInput = z.infer<typeof recommendationInputSchema>;

const DESCRIPTION =
  "Recommend one pack from the library, and up to three of its sounds, for the producer to hear and try in the beat. Use it when they ask for a sound, a sample or a pack. Name packs and sounds only by the IDs the library gives: anything else is refused. Nothing changes until the producer keeps a sound.";

/** The tool as it is offered to the model, on a turn that carries the library. */
export function recommendationTool(): ProviderTool {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(
    recommendationInputSchema,
    { io: "input" },
  ) as Record<string, unknown>;
  return {
    name: RECOMMEND_SOUNDS_TOOL,
    description: DESCRIPTION,
    input_schema: inputSchema as ProviderToolInputSchema,
    eager_input_streaming: true,
  };
}

/** A proposal's calls, with the recommendations taken out of the changes. */
export interface SplitProposal {
  /** The changes to the song, or null when the turn proposed none. */
  readonly proposal: AssistantProposal | null;
  /** Every recommendation call, in the order the model made them. */
  readonly recommendations: readonly AssistantToolCall[];
}

/** Takes the recommendation calls out of a turn's proposal. */
export function splitRecommendations(proposal: AssistantProposal): SplitProposal {
  const recommendations = proposal.calls.filter(
    (call) => call.name === RECOMMEND_SOUNDS_TOOL,
  );
  const changes = proposal.calls.filter((call) => call.name !== RECOMMEND_SOUNDS_TOOL);
  return {
    proposal: changes.length > 0 ? { ...proposal, calls: changes } : null,
    recommendations,
  };
}

/** Why a recommendation was refused. */
export const RECOMMENDATION_ISSUE_CODES = [
  /** The call is not a recommendation at all. */
  "malformed",
  /** The library holds no pack with that ID. */
  "unknown_pack",
  /** A sound is not in the library, or not in the pack it was named with. */
  "unknown_sound",
] as const;
export type RecommendationIssueCode = (typeof RECOMMENDATION_ISSUE_CODES)[number];

/** A recommendation whose every ID the library holds. */
export interface ValidRecommendation {
  readonly pack: AssistantLibraryPack;
  /** The pack's sounds it suggests, best first, without repeats. */
  readonly sounds: readonly AssistantLibrarySound[];
  readonly reason: string;
  /** The track it names, unchecked: the editor knows the song. Null for the selected one. */
  readonly trackId: string | null;
  /** The drum pad it names, unchecked like the track. Null for the selected pad. */
  readonly padId: string | null;
}

export type RecommendationValidation =
  | { readonly ok: true; readonly recommendation: ValidRecommendation }
  | {
      readonly ok: false;
      readonly code: RecommendationIssueCode;
      readonly message: string;
    };

function refuse(
  code: RecommendationIssueCode,
  message: string,
): RecommendationValidation {
  return { ok: false, code, message };
}

/**
 * Checks one recommendation call against `library`, the library the turn was
 * sent with. Never throws.
 */
export function validateRecommendation(
  input: unknown,
  library: AssistantLibraryContext,
): RecommendationValidation {
  const parsed = recommendationInputSchema.safeParse(input);
  if (!parsed.success) {
    return refuse(
      "malformed",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }
  const { packId, soundIds, reason, trackId, padId } = parsed.data;
  const pack = library.packs.find((candidate) => candidate.id === packId);
  if (!pack) return refuse("unknown_pack", `The library has no pack "${packId}"`);
  const sounds: AssistantLibrarySound[] = [];
  for (const soundId of new Set(soundIds)) {
    const sound = pack.sounds.find((candidate) => candidate.id === soundId);
    if (!sound) {
      return refuse(
        "unknown_sound",
        `The pack "${packId}" has no sound "${soundId.slice(0, 128)}"`,
      );
    }
    sounds.push(sound);
  }
  return {
    ok: true,
    recommendation: {
      pack,
      sounds,
      reason,
      trackId: trackId ?? null,
      padId: padId ?? null,
    },
  };
}
